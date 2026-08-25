import type { Capabilities, Profile, RemoteEntry } from '@shared/types'

export interface ProgressReport {
  /** Bytes transferred so far for the current file. */
  bytes: number
  /** Total bytes for the current file, 0 when unknown. */
  total: number
}

export type ProgressFn = (p: ProgressReport) => void

export interface TransferOptions {
  onProgress?: ProgressFn
  signal?: AbortSignal
}

/**
 * Every backend (SFTP today; S3 and Backblaze B2 next) implements this.
 * Paths are always absolute POSIX strings, so the renderer stays
 * provider-agnostic. Object stores fake directories from key prefixes and
 * report `realDirectories: false` in their capabilities.
 */
export interface Provider {
  readonly kind: Profile['kind']
  readonly capabilities: Capabilities

  connect(): Promise<void>
  disconnect(): Promise<void>

  /** Starting directory when a session opens. */
  home(): Promise<string>
  list(path: string): Promise<RemoteEntry[]>
  stat(path: string): Promise<RemoteEntry>

  mkdir(path: string): Promise<void>
  remove(path: string, recursive: boolean): Promise<void>
  rename(from: string, to: string): Promise<void>

  download(remotePath: string, localPath: string, opts?: TransferOptions): Promise<void>
  upload(localPath: string, remotePath: string, opts?: TransferOptions): Promise<void>

  /**
   * Reads up to `maxBytes` from the start of a file into memory, for previews.
   * Deliberately capped — callers must never use this to fetch whole files.
   */
  read(remotePath: string, maxBytes: number): Promise<Buffer>

  /** Emitted when the underlying connection drops on its own. */
  onClosed(cb: (reason?: string) => void): void
}

export class TransferAbortedError extends Error {
  constructor() {
    super('Transfer canceled')
    this.name = 'TransferAbortedError'
  }
}

/** POSIX path helpers — never use node:path here, remote separators are always "/". */
export const rpath = {
  join(...parts: string[]): string {
    const joined = parts
      .filter((p) => p.length > 0)
      .join('/')
      .replace(/\/+/g, '/')
    return joined.length > 1 ? joined.replace(/\/$/, '') : joined
  },
  dirname(p: string): string {
    const trimmed = p.replace(/\/+$/, '')
    const i = trimmed.lastIndexOf('/')
    if (i <= 0) return '/'
    return trimmed.slice(0, i)
  },
  basename(p: string): string {
    const trimmed = p.replace(/\/+$/, '')
    const i = trimmed.lastIndexOf('/')
    return i === -1 ? trimmed : trimmed.slice(i + 1)
  }
}
