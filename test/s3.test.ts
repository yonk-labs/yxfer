/** Drives the real S3 provider (via the AWS SDK) against a local S3 endpoint. */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'

import { sessions } from '../src/main/sessions'
import { store } from '../src/main/store'
import { transfers } from '../src/main/transfers'
import { Suite, waitFor } from './harness'
import { startS3Server } from './s3Server'

export async function runS3Suite(): Promise<number> {
  const s = new Suite('S3')

  const scratch = mkdtempSync(join(tmpdir(), 'yxfer-s3-'))
  app.setPath('userData', join(scratch, 'userData'))
  mkdirSync(app.getPath('userData'), { recursive: true })

  const localRoot = join(scratch, 'local')
  const dlRoot = join(scratch, 'dl')
  mkdirSync(localRoot)
  mkdirSync(dlRoot)

  const server = await startS3Server('my-backups')
  s.info(`S3 test endpoint on 127.0.0.1:${server.port}`)

  const seed = (key: string, body: string): void => {
    server.objects.set(key, { body: Buffer.from(body), lastModified: new Date() })
  }
  seed('team/notes.md', '# notes\n')
  seed('team/logs/app.log', 'log line\n')
  seed('team/logs/old.log', 'older\n')
  seed('other/ignored.txt', 'nope\n')

  const profile = store.upsertProfile({
    name: 'backups',
    kind: 's3',
    config: {
      bucket: 'my-backups',
      region: 'us-east-1',
      endpoint: `http://127.0.0.1:${server.port}`,
      prefix: 'team',
      accessKeyId: 'AKIATEST',
      forcePathStyle: true,
      hasStoredSecret: true
    }
  })
  store.setSecret(profile.id, 'secret-key')

  s.section('Connect')
  const session = await sessions.open(profile.id)
  s.check('session opened', Boolean(session.id))
  s.check('reports prefix-based directories', session.capabilities.realDirectories === false)
  s.check('reports no POSIX permissions', session.capabilities.permissions === false)
  s.check(
    'claims neither creation nor access time (S3 has only LastModified)',
    session.capabilities.createdTime === false && session.capabilities.accessedTime === false
  )

  const provider = sessions.provider(session.id)

  s.section('Browsing (prefix scoping)')
  const root = await provider.list('/')
  const names = root.map((e) => `${e.name}${e.type === 'dir' ? '/' : ''}`).sort()
  s.check('lists inside the configured prefix only', names.join(',') === 'logs/,notes.md', names.join(','))
  s.check('prefix becomes a directory', root.find((e) => e.name === 'logs')?.type === 'dir')
  s.check('object size reported', root.find((e) => e.name === 'notes.md')?.size === 8)
  s.check('object mtime reported', (root.find((e) => e.name === 'notes.md')?.mtime ?? 0) > 0)

  const logs = await provider.list('/logs')
  s.check(
    'lists a nested prefix',
    logs
      .map((e) => e.name)
      .sort()
      .join(',') === 'app.log,old.log'
  )

  s.section('Stat')
  s.check('stat root is a directory', (await provider.stat('/')).type === 'dir')
  s.check('stat object is a file', (await provider.stat('/notes.md')).type === 'file')
  s.check('stat prefix is a directory', (await provider.stat('/logs')).type === 'dir')
  let missing = false
  await provider.stat('/nope.txt').catch(() => (missing = true))
  s.check('stat on a missing key throws', missing)

  s.section('Ranged read (previews)')
  const head = await provider.read('/notes.md', 6)
  s.check('ranged GET returns only the prefix', head.toString() === '# note', JSON.stringify(head.toString()))
  const whole = await provider.read('/notes.md', 4096)
  s.check(
    'a cap beyond object size returns everything',
    whole.toString() === '# notes\n',
    JSON.stringify(whole.toString())
  )

  s.section('Create folder')
  await provider.mkdir('/archive')
  s.check('folder marker written', server.objects.has('team/archive/'))
  const withArchive = await provider.list('/')
  s.check(
    'new folder appears in listing',
    withArchive.some((e) => e.name === 'archive' && e.type === 'dir'),
    withArchive.map((e) => `${e.name}:${e.type}`).join(',')
  )

  s.section('Upload (single part)')
  writeFileSync(join(localRoot, 'small.txt'), 'hello s3\n')
  const smallIds = await transfers.upload(session.id, [join(localRoot, 'small.txt')], '/archive')
  s.check(
    'small upload completed',
    await waitFor(() => transfers.list().some((t) => t.id === smallIds[0] && t.state === 'done'))
  )
  s.check(
    'object stored at the prefixed key',
    server.objects.get('team/archive/small.txt')?.body.toString() === 'hello s3\n'
  )

  s.section('Upload (multipart)')
  const big = randomBytes(21 * 1024 * 1024) // spans 3 parts at 8 MB each
  writeFileSync(join(localRoot, 'big.bin'), big)
  const progress: number[] = []
  transfers.setEmitter((t) => {
    if (t.state === 'running' && t.bytes > 0) progress.push(t.bytes)
  })
  const bigIds = await transfers.upload(session.id, [join(localRoot, 'big.bin')], '/archive')
  s.check(
    'multipart upload completed',
    await waitFor(() => transfers.list().some((t) => t.id === bigIds[0] && t.state === 'done'))
  )
  const stored = server.objects.get('team/archive/big.bin')?.body ?? Buffer.alloc(0)
  s.check('21 MB object is byte-identical', stored.equals(big), `${stored.length} bytes`)
  s.check('multipart path was used', server.requests.some((r) => r.includes('uploads')))
  s.check('progress events fired', progress.length > 3, `${progress.length} events`)

  s.section('Recursive directory upload')
  mkdirSync(join(localRoot, 'tree', 'sub'), { recursive: true })
  writeFileSync(join(localRoot, 'tree', 'a.txt'), 'A')
  writeFileSync(join(localRoot, 'tree', 'sub', 'b.txt'), 'B')
  const treeIds = await transfers.upload(session.id, [join(localRoot, 'tree')], '/archive')
  s.check(
    'tree upload completed',
    await waitFor(
      () =>
        transfers.list().filter((t) => treeIds.includes(t.id) && t.state === 'done').length ===
        treeIds.length
    )
  )
  s.check('nested keys created', server.objects.has('team/archive/tree/sub/b.txt'))

  s.section('Download')
  const dlIds = await transfers.download(session.id, ['/archive/big.bin'], dlRoot)
  s.check(
    'download completed',
    await waitFor(() => transfers.list().some((t) => t.id === dlIds[0] && t.state === 'done'))
  )
  const roundTrip = existsSync(join(dlRoot, 'big.bin'))
    ? readFileSync(join(dlRoot, 'big.bin'))
    : Buffer.alloc(0)
  s.check('round-tripped 21 MB matches', roundTrip.equals(big), `${roundTrip.length} bytes`)

  s.section('Recursive directory download')
  const treeDl = await transfers.download(session.id, ['/archive/tree'], dlRoot)
  s.check('tree download produced jobs', treeDl.length === 2, String(treeDl.length))
  s.check(
    'tree download completed',
    await waitFor(
      () =>
        transfers.list().filter((t) => treeDl.includes(t.id) && t.state === 'done').length ===
        treeDl.length
    )
  )
  s.check('nested files landed locally', existsSync(join(dlRoot, 'tree', 'sub', 'b.txt')))

  s.section('Rename (copy + delete)')
  await provider.rename('/notes.md', '/README.md')
  s.check('renamed object exists', server.objects.has('team/README.md'))
  s.check('original removed', !server.objects.has('team/notes.md'))

  await provider.rename('/logs', '/logs-archive')
  s.check('prefix rename moved every key', server.objects.has('team/logs-archive/app.log'))
  s.check('prefix rename removed originals', !server.objects.has('team/logs/app.log'))

  s.section('Delete')
  await provider.remove('/README.md', false)
  s.check('object deleted', !server.objects.has('team/README.md'))
  await provider.remove('/logs-archive', true)
  s.check('recursive prefix deleted', !server.objects.has('team/logs-archive/old.log'))

  s.section('Isolation')
  s.check('keys outside the prefix untouched', server.objects.has('other/ignored.txt'))

  s.section('Error handling')
  const badProfile = store.upsertProfile({
    name: 'missing-bucket',
    kind: 's3',
    config: {
      bucket: 'does-not-exist',
      region: 'us-east-1',
      endpoint: `http://127.0.0.1:${server.port}`,
      accessKeyId: 'AKIATEST',
      forcePathStyle: true
    }
  })
  store.setSecret(badProfile.id, 'x')
  let message = ''
  await sessions.open(badProfile.id).catch((e: Error) => (message = e.message))
  s.check('missing bucket gives a clear error', /was not found/i.test(message), message)

  await sessions.close(session.id)
  await server.close()
  return s.done()
}
