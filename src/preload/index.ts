import { contextBridge, ipcRenderer, webUtils } from 'electron'

import type {
  MainEvent,
  PreviewPayload,
  Profile,
  RemoteEntry,
  SessionInfo,
  Transfer
} from '@shared/types'

/** Every handler in main returns this envelope; `invoke` unwraps it. */
type Envelope<T> = { ok: true; value: T } | { ok: false; error: string }

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as Envelope<T>
  if (!res.ok) throw new Error(res.error)
  return res.value
}

export interface Identity {
  path: string
  type: string
  encrypted: boolean
}

export interface SshConfigHost {
  alias: string
  hostname: string
  user?: string
  port?: number
  identityFiles: string[]
}

export interface AppSettings {
  downloadDir: string
  showHidden: boolean
  confirmDelete: boolean
  effectiveDownloadDir: string
}

const api = {
  profiles: {
    list: () => invoke<Profile[]>('profiles:list'),
    save: (input: Omit<Profile, 'id' | 'createdAt'> & { id?: string }) =>
      invoke<Profile>('profiles:save', input),
    remove: (id: string) => invoke<void>('profiles:delete', id),
    setSecret: (id: string, secret: string | null) =>
      invoke<void>('profiles:setSecret', id, secret),
    secretsAvailable: () => invoke<boolean>('profiles:secretsAvailable')
  },

  ssh: {
    identities: () => invoke<Identity[]>('ssh:identities'),
    configHosts: () => invoke<SshConfigHost[]>('ssh:configHosts'),
    hasAgent: () => invoke<boolean>('ssh:agent')
  },

  session: {
    open: (profileId: string, secret?: string) =>
      invoke<SessionInfo>('session:open', profileId, secret),
    close: (id: string) => invoke<void>('session:close', id),
    list: () => invoke<SessionInfo[]>('session:list')
  },

  fs: {
    list: (sessionId: string, path: string) => invoke<RemoteEntry[]>('fs:list', sessionId, path),
    home: (sessionId: string) => invoke<string>('fs:home', sessionId),
    stat: (sessionId: string, path: string) => invoke<RemoteEntry>('fs:stat', sessionId, path),
    mkdir: (sessionId: string, path: string) => invoke<void>('fs:mkdir', sessionId, path),
    remove: (sessionId: string, path: string, recursive = true) =>
      invoke<void>('fs:remove', sessionId, path, recursive),
    rename: (sessionId: string, from: string, to: string) =>
      invoke<void>('fs:rename', sessionId, from, to)
  },

  preview: {
    /** `asText` forces a text rendering even for images and binaries. */
    read: (sessionId: string, path: string, asText = false) =>
      invoke<PreviewPayload>('preview:read', sessionId, path, asText)
  },

  xfer: {
    upload: (sessionId: string, localPaths: string[], remoteDir: string) =>
      invoke<string[]>('xfer:upload', sessionId, localPaths, remoteDir),
    download: (sessionId: string, remotePaths: string[], localDir?: string) =>
      invoke<string[]>('xfer:download', sessionId, remotePaths, localDir),
    list: () => invoke<Transfer[]>('xfer:list'),
    cancel: (id: string) => invoke<void>('xfer:cancel', id),
    cancelAll: () => invoke<void>('xfer:cancelAll'),
    clearFinished: () => invoke<void>('xfer:clearFinished')
  },

  settings: {
    get: () => invoke<AppSettings>('settings:get'),
    set: (patch: Partial<Omit<AppSettings, 'effectiveDownloadDir'>>) =>
      invoke<AppSettings>('settings:set', patch)
  },

  hostKeys: {
    list: () => invoke<Array<{ host: string; fingerprint: string }>>('hostkeys:list'),
    forget: (host: string) => invoke<void>('hostkeys:forget', host)
  },

  dialog: {
    pickFiles: () => invoke<string[]>('dialog:pickFiles'),
    pickFolder: () => invoke<string | null>('dialog:pickFolder'),
    pickKey: () => invoke<string | null>('dialog:pickKey')
  },

  shell: {
    reveal: (path: string) => invoke<void>('shell:reveal', path),
    open: (path: string) => invoke<void>('shell:openPath', path),
    openDownloads: () => invoke<void>('shell:openDownloads')
  },

  /**
   * Starts a native drag of remote files onto the desktop. Fire this from a
   * dragstart handler — main downloads to a temp dir and takes over the drag.
   */
  startDrag: (sessionId: string, remotePaths: string[]) =>
    ipcRenderer.send('drag:start', sessionId, remotePaths),

  /**
   * Electron 32+ no longer exposes File.path, so the renderer needs this to
   * turn dropped files into absolute paths.
   */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),

  onEvent: (cb: (event: MainEvent) => void): (() => void) => {
    const listener = (_e: unknown, event: MainEvent): void => cb(event)
    ipcRenderer.on('main-event', listener)
    return () => ipcRenderer.removeListener('main-event', listener)
  },

  platform: process.platform
}

contextBridge.exposeInMainWorld('yxfer', api)

export type YxferApi = typeof api
