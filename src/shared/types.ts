/**
 * Types shared between main, preload and renderer.
 * Keep this file free of imports from either side.
 */

export type ProviderKind = 'sftp' | 's3' | 'b2'

/**
 * 'auto' tries the SSH agent first, then every private key found in ~/.ssh —
 * this is the default and covers most setups without configuration.
 */
export type AuthMethod = 'auto' | 'agent' | 'key' | 'password'

/** A saved connection. Secrets never live here — see SecretRef. */
export interface Profile {
  id: string
  name: string
  kind: ProviderKind
  /** Free-form per-provider settings. Discriminated by `kind`. */
  config: SftpConfig | S3Config
  /** Last directory browsed, restored on reconnect. */
  lastPath?: string
  createdAt: number
}

export interface SftpConfig {
  host: string
  port: number
  username: string
  auth: AuthMethod
  /** Path to a private key file, for auth === 'key'. */
  privateKeyPath?: string
  /** True when a password/passphrase is stored in the OS keychain for this profile. */
  hasStoredSecret?: boolean
  /** Directory to open on connect. Defaults to the SFTP home. */
  initialPath?: string
}

/** Placeholder — S3 and Backblaze B2 both speak the S3 API. */
export interface S3Config {
  endpoint?: string
  region: string
  bucket: string
  prefix?: string
  accessKeyId?: string
  hasStoredSecret?: boolean
  forcePathStyle?: boolean
}

export type EntryType = 'file' | 'dir' | 'symlink'

export interface RemoteEntry {
  name: string
  /** Absolute POSIX path on the remote. */
  path: string
  type: EntryType
  size: number
  /** Last-modified time, epoch millis. 0 when unknown. */
  mtime: number
  /**
   * Creation time, epoch millis, when the backend reports one.
   *
   * Neither SFTP v3 (all ssh2 speaks) nor the S3 API carries a creation
   * timestamp, so this is currently undefined for both — see
   * `Capabilities.createdTime`.
   */
  created?: number
  /** Last-access time, epoch millis. SFTP reports this; object stores do not. */
  accessed?: number
  /** POSIX mode bits, when the provider exposes them. */
  mode?: number
  /** Rendered permission string e.g. "drwxr-xr-x". */
  modeString?: string
  owner?: string
  group?: string
}

export interface Capabilities {
  mkdir: boolean
  remove: boolean
  rename: boolean
  /** Provider reports true directories rather than key prefixes. */
  realDirectories: boolean
  symlinks: boolean
  permissions: boolean
  /** Backend reports a creation time, so the Created column is worth showing. */
  createdTime: boolean
  /** Backend reports a last-access time. */
  accessedTime: boolean
}

export interface SessionInfo {
  id: string
  profileId: string
  name: string
  kind: ProviderKind
  home: string
  capabilities: Capabilities
}

export type TransferDirection = 'upload' | 'download'

export type TransferState =
  | 'queued'
  | 'running'
  | 'done'
  | 'error'
  | 'canceled'

export interface Transfer {
  id: string
  sessionId: string
  direction: TransferDirection
  /** Display name (basename). */
  name: string
  localPath: string
  remotePath: string
  state: TransferState
  bytes: number
  total: number
  /** Bytes/sec, smoothed. */
  rate: number
  startedAt: number
  endedAt?: number
  error?: string
}

/** Fired on the renderer for anything that changes outside a request. */
export type MainEvent =
  | { type: 'transfer'; transfer: Transfer }
  | { type: 'session-closed'; sessionId: string; reason?: string }
  | { type: 'notice'; kind: 'info' | 'error'; message: string }

export type PreviewKind = 'image' | 'text' | 'binary'

export interface PreviewPayload {
  kind: PreviewKind
  name: string
  path: string
  size: number
  mime?: string
  /** data: URL, for kind === 'image'. */
  dataUrl?: string
  /** Decoded contents, for kind === 'text'. */
  text?: string
  /** True when the file was longer than the preview cap. */
  truncated: boolean
  /** Why no preview is available, for kind === 'binary'. */
  reason?: string
}

export interface HostKeyPrompt {
  host: string
  port: number
  algorithm: string
  fingerprint: string
  /** True when we have a different key on record — a real warning. */
  changed: boolean
}
