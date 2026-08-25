/** Drives the real SFTP provider against an in-process SFTP server. */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { utils } from 'ssh2'

import { hostKeyStore } from '../src/main/hostkeys'
import { sessions } from '../src/main/sessions'
import { discoverIdentities, parseSshConfig } from '../src/main/sshIdentities'
import { store } from '../src/main/store'
import { transfers } from '../src/main/transfers'
import { Suite, waitFor } from './harness'
import { startServer } from './testServer'

export async function runSftpSuite(): Promise<number> {
  const s = new Suite('SFTP')

  const scratch = mkdtempSync(join(tmpdir(), 'yxfer-sftp-'))
  app.setPath('userData', join(scratch, 'userData'))
  mkdirSync(app.getPath('userData'), { recursive: true })

  const remoteRoot = join(scratch, 'remote')
  const localRoot = join(scratch, 'local')
  const downloadRoot = join(scratch, 'downloads')
  for (const d of [remoteRoot, localRoot, downloadRoot]) mkdirSync(d)

  writeFileSync(join(remoteRoot, 'hello.txt'), 'hello from the remote\n')
  mkdirSync(join(remoteRoot, 'logs'))
  writeFileSync(join(remoteRoot, 'logs', 'app.log'), 'line one\nline two\n')

  const bigPayload = randomBytes(5 * 1024 * 1024)
  writeFileSync(join(localRoot, 'payload.bin'), bigPayload)
  writeFileSync(join(localRoot, 'notes.md'), '# notes\n')
  mkdirSync(join(localRoot, 'nested', 'deep'), { recursive: true })
  writeFileSync(join(localRoot, 'nested', 'a.txt'), 'A')
  writeFileSync(join(localRoot, 'nested', 'deep', 'b.txt'), 'B')

  const server = await startServer(remoteRoot)
  const keyPath = join(scratch, 'test_key')
  writeFileSync(keyPath, utils.generateKeyPairSync('ed25519').private, { mode: 0o600 })

  s.section('SSH discovery')
  const identities = await discoverIdentities()
  s.check('discoverIdentities returns an array', Array.isArray(identities))
  s.info(
    `found ${identities.length} key(s) in ~/.ssh: ${
      identities
        .map((i) => `${i.path.split('/').pop()}${i.encrypted ? ' (encrypted)' : ''}`)
        .join(', ') || 'none'
    }`
  )
  const cfgHosts = await parseSshConfig()
  s.check('parseSshConfig returns an array', Array.isArray(cfgHosts))
  s.info(`parsed ${cfgHosts.length} host(s) from ~/.ssh/config`)

  s.section('Profiles & sessions')
  const profile = store.upsertProfile({
    name: 'test-host',
    kind: 'sftp',
    config: {
      host: '127.0.0.1',
      port: server.port,
      username: 'tester',
      auth: 'key',
      privateKeyPath: keyPath
    }
  })
  s.check('profile saved', store.listProfiles().length === 1)

  const session = await sessions.open(profile.id)
  s.check('session opened', Boolean(session.id))
  s.check('home resolved to /', session.home === '/', session.home)

  s.section('Browsing')
  const provider = sessions.provider(session.id)
  const listing = await provider.list('/')
  const names = listing.map((e) => e.name).sort()
  s.check('lists remote entries', names.join(',') === 'hello.txt,logs', names.join(','))
  const logs = listing.find((e) => e.name === 'logs')
  s.check('directory type detected', logs?.type === 'dir')
  s.check('mode string rendered', /^d/.test(logs?.modeString ?? ''), logs?.modeString)
  const hello = listing.find((e) => e.name === 'hello.txt')
  s.check('file size reported', hello?.size === 22, String(hello?.size))
  s.check('mtime present', (hello?.mtime ?? 0) > 0)
  s.check('atime surfaced as accessed', (hello?.accessed ?? 0) > 0, String(hello?.accessed))
  s.check(
    'no creation time claimed (absent from SFTP v3)',
    hello?.created === undefined && session.capabilities.createdTime === false
  )
  s.check('accessed time advertised in capabilities', session.capabilities.accessedTime === true)

  s.section('Ranged read (previews)')
  const head = await provider.read('/hello.txt', 5)
  s.check('reads only the requested prefix', head.toString() === 'hello', JSON.stringify(head.toString()))
  const whole = await provider.read('/hello.txt', 1024)
  s.check(
    'a cap beyond EOF returns the whole file',
    whole.toString() === 'hello from the remote\n',
    JSON.stringify(whole.toString())
  )

  s.section('Directory operations')
  await provider.mkdir('/uploads')
  s.check('mkdir', existsSync(join(remoteRoot, 'uploads')))
  await provider.rename('/uploads', '/incoming')
  s.check('rename', existsSync(join(remoteRoot, 'incoming')))

  s.section('Upload')
  const progressSeen: number[] = []
  transfers.setEmitter((t) => {
    if (t.state === 'running' && t.bytes > 0) progressSeen.push(t.bytes)
  })

  const upIds = await transfers.upload(
    session.id,
    [join(localRoot, 'payload.bin'), join(localRoot, 'notes.md')],
    '/incoming'
  )
  s.check('two upload jobs queued', upIds.length === 2, String(upIds.length))
  s.check(
    'uploads completed',
    await waitFor(
      () => transfers.list().filter((t) => upIds.includes(t.id) && t.state === 'done').length === 2
    )
  )
  const uploaded = existsSync(join(remoteRoot, 'incoming', 'payload.bin'))
    ? readFileSync(join(remoteRoot, 'incoming', 'payload.bin'))
    : Buffer.alloc(0)
  s.check(
    'uploaded 5 MB file is byte-identical',
    uploaded.equals(bigPayload),
    `${uploaded.length} bytes`
  )
  s.check(
    'progress events fired during upload',
    progressSeen.length > 5,
    `${progressSeen.length} events`
  )

  s.section('Recursive directory upload')
  const dirIds = await transfers.upload(session.id, [join(localRoot, 'nested')], '/incoming')
  s.check(
    'nested upload completed',
    await waitFor(
      () =>
        transfers.list().filter((t) => dirIds.includes(t.id) && t.state === 'done').length ===
        dirIds.length
    )
  )
  s.check(
    'nested tree recreated remotely',
    existsSync(join(remoteRoot, 'incoming', 'nested', 'deep', 'b.txt'))
  )

  s.section('Download')
  const downIds = await transfers.download(session.id, ['/incoming/payload.bin'], downloadRoot)
  s.check(
    'download completed',
    await waitFor(
      () => transfers.list().filter((t) => downIds.includes(t.id) && t.state === 'done').length === 1
    )
  )
  const roundTripped = existsSync(join(downloadRoot, 'payload.bin'))
    ? readFileSync(join(downloadRoot, 'payload.bin'))
    : Buffer.alloc(0)
  s.check('round-tripped file matches original', roundTripped.equals(bigPayload))

  s.section('Recursive directory download')
  const dirDownIds = await transfers.download(session.id, ['/incoming/nested'], downloadRoot)
  s.check(
    'nested download completed',
    await waitFor(
      () =>
        transfers.list().filter((t) => dirDownIds.includes(t.id) && t.state === 'done').length ===
        dirDownIds.length
    )
  )
  s.check('nested tree recreated locally', existsSync(join(downloadRoot, 'nested', 'deep', 'b.txt')))

  s.section('Cancellation')
  writeFileSync(join(localRoot, 'big2.bin'), randomBytes(24 * 1024 * 1024))
  const cancelIds = await transfers.upload(session.id, [join(localRoot, 'big2.bin')], '/incoming')
  await waitFor(() => transfers.list().some((t) => t.id === cancelIds[0] && t.state === 'running'))
  transfers.cancel(cancelIds[0])
  s.check(
    'in-flight transfer cancels',
    await waitFor(() =>
      transfers.list().some((t) => t.id === cancelIds[0] && t.state === 'canceled')
    )
  )

  s.section('Deletion')
  await provider.remove('/incoming/nested', true)
  s.check('recursive remove', !existsSync(join(remoteRoot, 'incoming', 'nested')))
  await provider.remove('/incoming/notes.md', false)
  s.check('file remove', !existsSync(join(remoteRoot, 'incoming', 'notes.md')))

  s.section('Host key pinning')
  const recorded = hostKeyStore.list()
  s.check('host key recorded on first connect', recorded.length === 1, JSON.stringify(recorded))
  s.check(
    'fingerprint looks like SHA256:...',
    /^SHA256:[A-Za-z0-9+/]+$/.test(recorded[0]?.fingerprint ?? ''),
    recorded[0]?.fingerprint
  )
  s.check(
    'changed host key is rejected',
    hostKeyStore.verify('127.0.0.1', server.port, Buffer.from('a different key')).ok === false
  )

  s.section('Secrets')
  s.info(`safeStorage encryption available: ${store.secretsAvailable()}`)
  if (store.secretsAvailable()) {
    store.setSecret(profile.id, 'hunter2')
    s.check('secret round-trips through safeStorage', store.getSecret(profile.id) === 'hunter2')
    store.setSecret(profile.id, null)
    s.check('secret cleared', store.getSecret(profile.id) === undefined)
  }

  s.section('Reconnect')
  await sessions.close(session.id)
  s.check('session list empty after close', sessions.list().length === 0)
  const again = await sessions.open(profile.id)
  s.check('reconnects successfully', Boolean(again.id))
  s.check(
    'remembered last path restored',
    again.home === '/incoming' || again.home === '/',
    again.home
  )
  await sessions.close(again.id)

  await server.close()
  return s.done()
}
