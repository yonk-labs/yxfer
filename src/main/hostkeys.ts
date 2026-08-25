import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

type KnownHosts = Record<string, string>

export interface Verdict {
  ok: boolean
  offered: string
  known?: string
}

/**
 * Trust-on-first-use host key tracking.
 *
 * The first key seen for a host:port is recorded and accepted; a later
 * mismatch is refused loudly. This is deliberately not a full known_hosts
 * implementation — it does not read ~/.ssh/known_hosts — so the two stores
 * can disagree. It exists so a changed key cannot pass silently.
 */
class HostKeyStore {
  private cache: KnownHosts | null = null

  private get file(): string {
    return join(app.getPath('userData'), 'known-hosts.json')
  }

  private load(): KnownHosts {
    if (this.cache) return this.cache
    try {
      this.cache = JSON.parse(readFileSync(this.file, 'utf8')) as KnownHosts
    } catch {
      this.cache = {}
    }
    return this.cache
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.cache ?? {}, null, 2), { mode: 0o600 })
  }

  static fingerprint(key: Buffer): string {
    return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
  }

  verify(host: string, port: number, key: Buffer): Verdict {
    const hosts = this.load()
    const id = `${host}:${port}`
    const offered = HostKeyStore.fingerprint(key)
    const known = hosts[id]

    if (!known) {
      hosts[id] = offered
      this.save()
      return { ok: true, offered }
    }
    return { ok: known === offered, offered, known }
  }

  list(): Array<{ host: string; fingerprint: string }> {
    return Object.entries(this.load()).map(([host, fingerprint]) => ({ host, fingerprint }))
  }

  forget(host: string): void {
    const hosts = this.load()
    delete hosts[host]
    this.save()
  }
}

export const hostKeyStore = new HostKeyStore()
