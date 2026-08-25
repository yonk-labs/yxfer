import { join } from 'node:path'
import { BrowserWindow, app, shell } from 'electron'

import type { MainEvent } from '@shared/types'
import { cleanupTempDirs, registerIpc, setBroadcaster } from './ipc'
import { sessions } from './sessions'
import { transfers } from './transfers'

let mainWindow: BrowserWindow | null = null

function broadcast(event: MainEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('main-event', event)
}

export function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 860,
    minHeight: 520,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#12141a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow = window

  // Show on first paint, but never stay hidden: an invisible window reads as
  // "the app failed to launch", so reveal it even if the renderer misbehaves.
  const reveal = (): void => {
    if (!window.isDestroyed() && !window.isVisible()) window.show()
  }
  window.once('ready-to-show', reveal)
  const revealTimer = setTimeout(reveal, 4000)
  window.on('closed', () => clearTimeout(revealTimer))

  window.webContents.on('did-fail-load', (_e, code, description) => {
    console.error(`Renderer failed to load: ${description} (${code})`)
    reveal()
  })

  // Keep navigation inside the app; open real links in the user's browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

app.whenReady().then(() => {
  setBroadcaster(broadcast)
  transfers.setEmitter((transfer) => broadcast({ type: 'transfer', transfer }))
  sessions.onClose((sessionId, reason) => broadcast({ type: 'session-closed', sessionId, reason }))

  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  transfers.cancelAll()
  await sessions.closeAll()
  await cleanupTempDirs()
})
