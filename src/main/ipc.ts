import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, dialog, ipcMain, nativeImage, shell } from 'electron'

import type { MainEvent, Profile } from '@shared/types'
import { hostKeyStore } from './hostkeys'
import { buildPreview } from './preview'
import { rpath } from './providers/provider'
import { sessions } from './sessions'
import { store } from './store'
import { agentSocket, discoverIdentities, parseSshConfig } from './sshIdentities'
import { transfers } from './transfers'

type Broadcaster = (event: MainEvent) => void

let broadcast: Broadcaster = () => {}
const tempDirs: string[] = []

export function setBroadcaster(fn: Broadcaster): void {
  broadcast = fn
}

export function downloadDir(): string {
  const configured = store.getSettings().downloadDir
  return configured || app.getPath('downloads') || join(homedir(), 'Downloads')
}

/** Wraps a handler so thrown errors reach the renderer as plain messages. */
function handle<T extends unknown[], R>(channel: string, fn: (...args: T) => Promise<R> | R): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true as const, value: await fn(...(args as T)) }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

export function registerIpc(): void {
  // ---- profiles -------------------------------------------------------
  handle('profiles:list', () => store.listProfiles())
  handle('profiles:save', (input: Omit<Profile, 'id' | 'createdAt'> & { id?: string }) =>
    store.upsertProfile(input)
  )
  handle('profiles:delete', (id: string) => store.deleteProfile(id))
  handle('profiles:setSecret', (id: string, secret: string | null) => store.setSecret(id, secret))
  handle('profiles:secretsAvailable', () => store.secretsAvailable())

  // ---- ssh discovery --------------------------------------------------
  handle('ssh:identities', () => discoverIdentities())
  handle('ssh:configHosts', () => parseSshConfig())
  handle('ssh:agent', () => Boolean(agentSocket()))

  // ---- sessions -------------------------------------------------------
  handle('session:open', (profileId: string, secret?: string) => sessions.open(profileId, secret))
  handle('session:close', (id: string) => sessions.close(id))
  handle('session:list', () => sessions.list())

  // ---- remote filesystem ---------------------------------------------
  handle('fs:list', async (sessionId: string, path: string) => {
    const entries = await sessions.provider(sessionId).list(path)
    store.rememberPath(sessions.get(sessionId).info.profileId, path)
    return entries
  })
  handle('fs:home', (sessionId: string) => sessions.provider(sessionId).home())
  handle('fs:stat', (sessionId: string, path: string) => sessions.provider(sessionId).stat(path))
  handle('fs:mkdir', (sessionId: string, path: string) => sessions.provider(sessionId).mkdir(path))
  handle('fs:remove', (sessionId: string, path: string, recursive: boolean) =>
    sessions.provider(sessionId).remove(path, recursive)
  )
  handle('fs:rename', (sessionId: string, from: string, to: string) =>
    sessions.provider(sessionId).rename(from, to)
  )

  // ---- preview --------------------------------------------------------
  handle('preview:read', (sessionId: string, path: string, asText?: boolean) =>
    buildPreview(sessionId, path, { asText })
  )

  // ---- transfers ------------------------------------------------------
  handle('xfer:upload', (sessionId: string, localPaths: string[], remoteDir: string) =>
    transfers.upload(sessionId, localPaths, remoteDir)
  )
  handle('xfer:download', (sessionId: string, remotePaths: string[], localDir?: string) =>
    transfers.download(sessionId, remotePaths, localDir || downloadDir())
  )
  handle('xfer:list', () => transfers.list())
  handle('xfer:cancel', (id: string) => transfers.cancel(id))
  handle('xfer:cancelAll', () => transfers.cancelAll())
  handle('xfer:clearFinished', () => transfers.clearFinished())

  // ---- settings & host keys ------------------------------------------
  handle('settings:get', () => ({ ...store.getSettings(), effectiveDownloadDir: downloadDir() }))
  handle('settings:set', (patch: Record<string, unknown>) => store.setSettings(patch))
  handle('hostkeys:list', () => hostKeyStore.list())
  handle('hostkeys:forget', (host: string) => hostKeyStore.forget(host))

  // ---- dialogs & shell -------------------------------------------------
  handle('dialog:pickFiles', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
    return r.canceled ? [] : r.filePaths
  })
  handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  handle('dialog:pickKey', async () => {
    const r = await dialog.showOpenDialog({
      title: 'Choose a private key',
      defaultPath: join(homedir(), '.ssh'),
      properties: ['openFile', 'showHiddenFiles']
    })
    return r.canceled ? null : r.filePaths[0]
  })
  handle('shell:reveal', (path: string) => shell.showItemInFolder(path))
  handle('shell:openPath', (path: string) => shell.openPath(path))
  handle('shell:openDownloads', () => shell.openPath(downloadDir()))

  // ---- drag out to the desktop ----------------------------------------
  ipcMain.on('drag:start', (event, sessionId: string, remotePaths: string[]) => {
    void startDragOut(event.sender, sessionId, remotePaths)
  })
}

/**
 * Dragging a remote file to Finder requires a real local file, and
 * `startDrag` only takes effect while the mouse is still down. So we fetch to
 * a temp dir and start the drag if it lands quickly; anything slower falls
 * back to a normal queued download, which the transfer panel reports.
 *
 * Electron exposes no promised-file API (NSFilePromiseProvider), so this
 * budget is the honest ceiling for drag-out.
 */
const DRAG_BUDGET_MS = 2000

/** 16×16 transparent PNG, used only if the OS has no icon for the file. */
const FALLBACK_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHElEQVQ4jWNgGAWjYBSMglEwCkbBKBgFo2AUAAAGgAABsvZFxwAAAABJRU5ErkJggg=='

async function startDragOut(
  sender: Electron.WebContents,
  sessionId: string,
  remotePaths: string[]
): Promise<void> {
  let temp: string
  try {
    temp = await mkdtemp(join(tmpdir(), 'yxfer-'))
    tempDirs.push(temp)
  } catch {
    return
  }

  const files = remotePaths.map((p) => join(temp, rpath.basename(p)))

  const raced = await Promise.race([
    transfers
      .download(sessionId, remotePaths, temp)
      .then(async (ids) => {
        await waitForTransfers(ids)
        return 'ready' as const
      }),
    new Promise<'slow'>((resolve) => setTimeout(() => resolve('slow'), DRAG_BUDGET_MS))
  ]).catch(() => 'failed' as const)

  if (raced === 'ready') {
    try {
      // startDrag rejects an empty icon, so borrow the file's own system icon.
      const icon = await app
        .getFileIcon(files[0], { size: 'normal' })
        .catch(() => nativeImage.createFromDataURL(FALLBACK_ICON))
      sender.startDrag({ file: files[0], files, icon })
      return
    } catch {
      // The drag gesture already ended — fall through to a plain download.
    }
  }

  if (raced === 'failed') return

  // Too slow to ride the drag gesture — finish it as a normal download and say so.
  broadcast({
    type: 'notice',
    kind: 'info',
    message: `Too large to drop directly — downloading to ${downloadDir()} instead.`
  })
  void transfers.download(sessionId, remotePaths, downloadDir()).catch(() => {
    // Already surfaced in the transfer list.
  })
}

/** Resolves once none of the given transfer ids are queued or running. */
function waitForTransfers(ids: string[]): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      const pending = transfers
        .list()
        .filter((t) => ids.includes(t.id) && (t.state === 'queued' || t.state === 'running'))
      if (pending.length === 0) resolve()
      else setTimeout(check, 60)
    }
    check()
  })
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.allSettled(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
}
