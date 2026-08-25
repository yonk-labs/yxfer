import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir as mkdirLocal, readFile, stat as statLocal } from 'node:fs/promises'
import { basename, dirname as localDirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Client, type FileEntryWithStats, type SFTPWrapper, type Stats } from 'ssh2'

import type { Capabilities, RemoteEntry, SftpConfig } from '@shared/types'
import { countingStream } from './progress'
import { rpath, type Provider, type TransferOptions } from './provider'
import { hostKeyStore } from '../hostkeys'
import { agentSocket, discoverIdentities } from '../sshIdentities'

/** Thrown when the offered host key differs from the one recorded on first use. */
export class HostKeyMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostKeyMismatchError'
  }
}

/** Renders POSIX mode bits the way `ls -l` does. */
function modeString(mode: number, type: RemoteEntry['type']): string {
  const rwx = (bits: number): string =>
    `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${bits & 1 ? 'x' : '-'}`
  const lead = type === 'dir' ? 'd' : type === 'symlink' ? 'l' : '-'
  return lead + rwx((mode >> 6) & 7) + rwx((mode >> 3) & 7) + rwx(mode & 7)
}

function entryType(attrs: Stats): RemoteEntry['type'] {
  if (attrs.isDirectory()) return 'dir'
  if (attrs.isSymbolicLink()) return 'symlink'
  return 'file'
}

export interface SftpSecrets {
  /** Password for password auth, or passphrase for an encrypted key. */
  password?: string
}

export class SftpProvider implements Provider {
  readonly kind = 'sftp' as const

  readonly capabilities: Capabilities = {
    mkdir: true,
    remove: true,
    rename: true,
    realDirectories: true,
    symlinks: true,
    permissions: true,
    // SFTP v3 attributes carry only atime and mtime — there is no birth time
    // in the protocol, so a Created column would always be empty.
    createdTime: false,
    accessedTime: true
  }

  private client: Client | null = null
  private sftp: SFTPWrapper | null = null
  private closedCbs: Array<(reason?: string) => void> = []
  /** Set once we hand the drop to the UI, so we do not double-report. */
  private reportedClose = false

  constructor(
    private readonly config: SftpConfig,
    private readonly secrets: SftpSecrets = {}
  ) {}

  onClosed(cb: (reason?: string) => void): void {
    this.closedCbs.push(cb)
  }

  private reportClosed(reason?: string): void {
    if (this.reportedClose) return
    this.reportedClose = true
    for (const cb of this.closedCbs) cb(reason)
  }

  /**
   * Builds the ordered list of credentials to try. For 'auto' that is the
   * agent (when one is running) followed by each discovered ~/.ssh key,
   * mirroring what `ssh` itself would do.
   */
  private async buildAttempts(): Promise<Array<{ label: string; opts: Record<string, unknown> }>> {
    const { auth, privateKeyPath } = this.config
    const attempts: Array<{ label: string; opts: Record<string, unknown> }> = []

    const withKey = async (path: string, label: string): Promise<void> => {
      const opts: Record<string, unknown> = { privateKey: await readFile(path) }
      if (this.secrets.password) opts.passphrase = this.secrets.password
      attempts.push({ label, opts })
    }

    if (auth === 'password') {
      if (!this.secrets.password) throw new Error('No password supplied')
      return [{ label: 'password', opts: { password: this.secrets.password } }]
    }

    if (auth === 'key') {
      if (!privateKeyPath) throw new Error('No private key path configured')
      await withKey(privateKeyPath, basename(privateKeyPath))
      return attempts
    }

    const sock = agentSocket()
    if (sock) attempts.push({ label: 'ssh-agent', opts: { agent: sock } })

    if (auth === 'agent') {
      if (!attempts.length) {
        throw new Error(
          'No SSH agent found (SSH_AUTH_SOCK is unset). Run `ssh-add`, or switch this connection to automatic or password auth.'
        )
      }
      return attempts
    }

    // auth === 'auto'
    for (const id of await discoverIdentities()) {
      // An encrypted key without a stored passphrase would just fail; the
      // agent usually already holds it, so skip rather than error.
      if (id.encrypted && !this.secrets.password) continue
      await withKey(id.path, basename(id.path))
    }

    if (!attempts.length) {
      throw new Error(
        'No SSH agent and no usable keys in ~/.ssh. Add a key with `ssh-add`, choose a key file, or use password auth.'
      )
    }
    return attempts
  }

  async connect(): Promise<void> {
    const attempts = await this.buildAttempts()
    const failures: string[] = []

    for (const attempt of attempts) {
      try {
        await this.connectWith(attempt.opts)
        this.authMethodUsed = attempt.label
        return
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // A host key mismatch is fatal regardless of which credential we tried.
        if (err instanceof HostKeyMismatchError) throw err
        failures.push(`${attempt.label}: ${message}`)
        await this.disconnect()
        this.reportedClose = false
      }
    }

    throw new Error(
      `Could not authenticate to ${this.config.host} as ${this.config.username}.\n` +
        failures.map((f) => `  • ${f}`).join('\n')
    )
  }

  /** Which credential actually worked — surfaced in the UI. */
  authMethodUsed = ''

  private async connectWith(authOpts: Record<string, unknown>): Promise<void> {
    const { host, port, username } = this.config

    const client = new Client()
    this.client = client

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const fail = (err: Error): void => {
        if (settled) return
        settled = true
        reject(err)
      }

      client.on('ready', () => {
        if (settled) return
        settled = true
        resolve()
      })
      client.on('error', (err) => {
        // After `ready`, errors are connection drops rather than setup failures.
        if (settled) this.reportClosed(err.message)
        else fail(err)
      })
      client.on('close', () => {
        if (settled) this.reportClosed()
        else fail(new Error('Connection closed before authentication completed'))
      })
      client.on('end', () => {
        if (settled) this.reportClosed()
      })

      client.connect({
        host,
        port,
        username,
        readyTimeout: 20_000,
        keepaliveInterval: 15_000,
        ...authOpts,
        hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
          const verdict = hostKeyStore.verify(host, port, key)
          if (verdict.ok) {
            verify(true)
            return
          }
          verify(false)
          // `verify(false)` surfaces a generic auth failure, so attach the detail.
          fail(
            new HostKeyMismatchError(
              `Host key for ${host}:${port} does not match the key recorded on first connect.\n` +
                `Recorded: ${verdict.known}\nOffered:  ${verdict.offered}\n` +
                'If this change is expected, remove the host from Settings › Known hosts and reconnect.'
            )
          )
        }
      })
    })

    this.sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)))
    })
  }

  async disconnect(): Promise<void> {
    this.reportedClose = true // an intentional close is not an event worth reporting
    this.sftp = null
    this.client?.end()
    this.client = null
  }

  private conn(): SFTPWrapper {
    if (!this.sftp) throw new Error('Not connected')
    return this.sftp
  }

  async home(): Promise<string> {
    if (this.config.initialPath) return this.config.initialPath
    const sftp = this.conn()
    return new Promise<string>((resolve, reject) => {
      sftp.realpath('.', (err, path) => (err ? reject(err) : resolve(path)))
    })
  }

  async list(path: string): Promise<RemoteEntry[]> {
    const sftp = this.conn()
    const items = await new Promise<FileEntryWithStats[]>((resolve, reject) => {
      sftp.readdir(path, (err, list) => (err ? reject(err) : resolve(list)))
    })

    return items
      .filter((i) => i.filename !== '.' && i.filename !== '..')
      .map((i) => {
        const type = entryType(i.attrs)
        // longname is `ls -l` output; columns 3 and 4 are owner and group.
        const cols = i.longname.split(/\s+/)
        return {
          name: i.filename,
          path: rpath.join(path, i.filename),
          type,
          size: i.attrs.size ?? 0,
          mtime: (i.attrs.mtime ?? 0) * 1000,
          accessed: i.attrs.atime ? i.attrs.atime * 1000 : undefined,
          mode: i.attrs.mode,
          modeString: modeString(i.attrs.mode, type),
          owner: cols[2],
          group: cols[3]
        } satisfies RemoteEntry
      })
  }

  async stat(path: string): Promise<RemoteEntry> {
    const sftp = this.conn()
    const attrs = await new Promise<Stats>((resolve, reject) => {
      sftp.stat(path, (err, s) => (err ? reject(err) : resolve(s)))
    })
    const type = entryType(attrs)
    return {
      name: rpath.basename(path),
      path,
      type,
      size: attrs.size ?? 0,
      mtime: (attrs.mtime ?? 0) * 1000,
      accessed: attrs.atime ? attrs.atime * 1000 : undefined,
      mode: attrs.mode,
      modeString: modeString(attrs.mode, type)
    }
  }

  async mkdir(path: string): Promise<void> {
    const sftp = this.conn()
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(path, (err) => (err ? reject(err) : resolve()))
    })
  }

  async remove(path: string, recursive: boolean): Promise<void> {
    const sftp = this.conn()
    const entry = await this.stat(path)

    if (entry.type !== 'dir') {
      await new Promise<void>((resolve, reject) => {
        sftp.unlink(path, (err) => (err ? reject(err) : resolve()))
      })
      return
    }

    if (recursive) {
      for (const child of await this.list(path)) {
        await this.remove(child.path, true)
      }
    }
    await new Promise<void>((resolve, reject) => {
      sftp.rmdir(path, (err) => (err ? reject(err) : resolve()))
    })
  }

  async rename(from: string, to: string): Promise<void> {
    const sftp = this.conn()
    await new Promise<void>((resolve, reject) => {
      sftp.rename(from, to, (err) => (err ? reject(err) : resolve()))
    })
  }

  async read(remotePath: string, maxBytes: number): Promise<Buffer> {
    const sftp = this.conn()
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      // ssh2's `end` is inclusive, so ask for one less than the byte count.
      const stream = sftp.createReadStream(remotePath, { start: 0, end: maxBytes - 1 })
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('error', reject)
      stream.on('end', () => resolve(Buffer.concat(chunks)))
    })
  }

  async download(remotePath: string, localPath: string, opts: TransferOptions = {}): Promise<void> {
    const sftp = this.conn()
    const { size } = await this.stat(remotePath)
    await mkdirLocal(localDirname(localPath), { recursive: true })

    const read = sftp.createReadStream(remotePath, { highWaterMark: 256 * 1024 })
    const write = createWriteStream(localPath)
    await pipeline(read, countingStream(size, opts), write, { signal: opts.signal })
  }

  async upload(localPath: string, remotePath: string, opts: TransferOptions = {}): Promise<void> {
    const sftp = this.conn()
    const { size } = await statLocal(localPath)

    const read = createReadStream(localPath, { highWaterMark: 256 * 1024 })
    const write = sftp.createWriteStream(remotePath, { highWaterMark: 256 * 1024 })
    await pipeline(read, countingStream(size, opts), write, { signal: opts.signal })
  }
}
