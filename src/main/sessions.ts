import { randomUUID } from 'node:crypto'

import type { Profile, S3Config, SessionInfo, SftpConfig } from '@shared/types'
import type { Provider } from './providers/provider'
import { S3Provider } from './providers/s3'
import { SftpProvider } from './providers/sftp'
import { store } from './store'

export interface Session {
  info: SessionInfo
  provider: Provider
}

type CloseListener = (sessionId: string, reason?: string) => void

/**
 * Owns live connections. Providers are constructed here, which is the single
 * place that needs to grow when S3 and B2 land.
 */
class SessionManager {
  private sessions = new Map<string, Session>()
  private closeListeners: CloseListener[] = []

  onClose(cb: CloseListener): void {
    this.closeListeners.push(cb)
  }

  private build(profile: Profile, secret?: string): Provider {
    switch (profile.kind) {
      case 'sftp':
        return new SftpProvider(profile.config as SftpConfig, { password: secret })
      case 's3':
      case 'b2':
        return new S3Provider(
          profile.config as S3Config,
          { secretAccessKey: secret },
          profile.kind
        )
      default:
        throw new Error(`Unknown provider: ${String(profile.kind)}`)
    }
  }

  async open(profileId: string, oneTimeSecret?: string): Promise<SessionInfo> {
    const profile = store.getProfile(profileId)
    if (!profile) throw new Error('Profile not found')

    const secret = oneTimeSecret ?? store.getSecret(profileId)
    const provider = this.build(profile, secret)
    await provider.connect()

    const id = randomUUID()
    const home = profile.lastPath ?? (await provider.home())

    // Fall back to home if the remembered directory has since disappeared.
    let startPath = home
    try {
      const entry = await provider.stat(startPath)
      if (entry.type !== 'dir') startPath = await provider.home()
    } catch {
      startPath = await provider.home()
    }

    const info: SessionInfo = {
      id,
      profileId,
      name: profile.name,
      kind: profile.kind,
      home: startPath,
      capabilities: provider.capabilities
    }

    provider.onClosed((reason) => {
      this.sessions.delete(id)
      for (const cb of this.closeListeners) cb(id, reason)
    })

    this.sessions.set(id, { info, provider })
    return info
  }

  get(id: string): Session {
    const s = this.sessions.get(id)
    if (!s) throw new Error('Session is no longer connected')
    return s
  }

  provider(id: string): Provider {
    return this.get(id).provider
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info)
  }

  async close(id: string): Promise<void> {
    const s = this.sessions.get(id)
    if (!s) return
    this.sessions.delete(id)
    await s.provider.disconnect()
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.close(id)))
  }
}

export const sessions = new SessionManager()
