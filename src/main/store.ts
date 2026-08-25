import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'

import type { Profile } from '@shared/types'

export interface Settings {
  /** Where drag-out and explicit downloads land. Empty means ~/Downloads. */
  downloadDir: string
  /** Show dotfiles in remote listings. */
  showHidden: boolean
  /** Confirm before deleting remote files. */
  confirmDelete: boolean
}

interface Disk {
  profiles: Profile[]
  /** profileId -> base64 of an OS-encrypted blob. */
  secrets: Record<string, string>
  settings: Settings
}

const DEFAULT_SETTINGS: Settings = { downloadDir: '', showHidden: false, confirmDelete: true }

/**
 * Connection profiles on disk; passwords and key passphrases encrypted with
 * Electron's safeStorage (Keychain on macOS, DPAPI on Windows, libsecret on
 * Linux). When the OS keyring is unavailable we refuse to store the secret
 * rather than writing it in the clear.
 */
class Store {
  private data: Disk | null = null

  private get file(): string {
    return join(app.getPath('userData'), 'profiles.json')
  }

  private load(): Disk {
    if (this.data) return this.data
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Disk>
      this.data = {
        profiles: parsed.profiles ?? [],
        secrets: parsed.secrets ?? {},
        settings: { ...DEFAULT_SETTINGS, ...parsed.settings }
      }
    } catch {
      this.data = { profiles: [], secrets: {}, settings: { ...DEFAULT_SETTINGS } }
    }
    return this.data
  }

  getSettings(): Settings {
    return { ...this.load().settings }
  }

  setSettings(patch: Partial<Settings>): Settings {
    const disk = this.load()
    disk.settings = { ...disk.settings, ...patch }
    this.save()
    return { ...disk.settings }
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.load(), null, 2), { mode: 0o600 })
  }

  listProfiles(): Profile[] {
    return [...this.load().profiles].sort((a, b) => a.name.localeCompare(b.name))
  }

  getProfile(id: string): Profile | undefined {
    return this.load().profiles.find((p) => p.id === id)
  }

  upsertProfile(input: Omit<Profile, 'id' | 'createdAt'> & { id?: string }): Profile {
    const disk = this.load()
    const existing = input.id ? disk.profiles.find((p) => p.id === input.id) : undefined

    const profile: Profile = {
      ...input,
      id: existing?.id ?? input.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? Date.now()
    }

    const i = disk.profiles.findIndex((p) => p.id === profile.id)
    if (i === -1) disk.profiles.push(profile)
    else disk.profiles[i] = profile

    this.save()
    return profile
  }

  deleteProfile(id: string): void {
    const disk = this.load()
    disk.profiles = disk.profiles.filter((p) => p.id !== id)
    delete disk.secrets[id]
    this.save()
  }

  /** Persists the last browsed directory without a full profile round-trip. */
  rememberPath(id: string, path: string): void {
    const profile = this.getProfile(id)
    if (!profile || profile.lastPath === path) return
    profile.lastPath = path
    this.save()
  }

  secretsAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  setSecret(profileId: string, secret: string | null): void {
    const disk = this.load()
    if (secret === null || secret === '') {
      delete disk.secrets[profileId]
      this.save()
      return
    }
    if (!this.secretsAvailable()) {
      throw new Error(
        'The OS keychain is unavailable, so the password cannot be saved. yxfer will ask for it each time you connect.'
      )
    }
    disk.secrets[profileId] = safeStorage.encryptString(secret).toString('base64')
    this.save()
  }

  getSecret(profileId: string): string | undefined {
    const blob = this.load().secrets[profileId]
    if (!blob) return undefined
    try {
      return safeStorage.decryptString(Buffer.from(blob, 'base64'))
    } catch {
      // Keychain rotated or the entry was written on another machine.
      return undefined
    }
  }
}

export const store = new Store()
