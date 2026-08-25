import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

export interface Identity {
  path: string
  /** Key type inferred from the filename or PEM header. */
  type: string
  /** True when the key needs a passphrase to use. */
  encrypted: boolean
}

export interface SshConfigHost {
  alias: string
  hostname: string
  user?: string
  port?: number
  identityFiles: string[]
}

/** Preferred order, matching OpenSSH's own default identity order. */
const DEFAULT_KEY_NAMES = [
  'id_ed25519',
  'id_ed25519_sk',
  'id_ecdsa',
  'id_ecdsa_sk',
  'id_rsa',
  'id_dsa'
]

export function sshDir(): string {
  return join(homedir(), '.ssh')
}

/** Expands `~`, `$HOME`, and paths relative to ~/.ssh the way ssh_config does. */
export function expandPath(p: string): string {
  let out = p.trim().replace(/^["']|["']$/g, '')
  if (out.startsWith('~/')) out = join(homedir(), out.slice(2))
  else if (out === '~') out = homedir()
  out = out.replace(/^\$HOME/, homedir())
  return resolve(out.startsWith('/') ? out : join(sshDir(), out))
}

/**
 * Reads a private key just far enough to tell whether it is passphrase
 * protected. Both the legacy PEM and the modern `openssh-key-v1` container
 * announce their cipher in the clear, so no crypto is needed.
 */
function isEncrypted(text: string): boolean {
  if (/Proc-Type:\s*4,ENCRYPTED/.test(text)) return true
  if (text.includes('BEGIN ENCRYPTED PRIVATE KEY')) return true

  const match = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END/.exec(text)
  if (!match) return false

  try {
    const buf = Buffer.from(match[1].replace(/\s+/g, ''), 'base64')
    const magic = 'openssh-key-v1\0'
    if (!buf.subarray(0, magic.length).toString('binary').startsWith(magic)) return false
    // Layout after the magic: uint32 length + cipher name.
    const len = buf.readUInt32BE(magic.length)
    const cipher = buf.subarray(magic.length + 4, magic.length + 4 + len).toString('utf8')
    return cipher !== 'none'
  } catch {
    // Unreadable container — assume a passphrase so we prompt rather than fail silently.
    return true
  }
}

function keyType(name: string, text: string): string {
  const m = /^id_([a-z0-9]+)/i.exec(basename(name))
  if (m) return m[1].toLowerCase()
  if (text.includes('BEGIN RSA PRIVATE KEY')) return 'rsa'
  if (text.includes('BEGIN OPENSSH PRIVATE KEY')) return 'openssh'
  return 'unknown'
}

/**
 * Finds usable private keys in ~/.ssh. A file counts as a key when it has a
 * PEM header — that avoids treating config, known_hosts, or .pub files as keys.
 * Results are ordered with OpenSSH's default names first.
 */
export async function discoverIdentities(): Promise<Identity[]> {
  let names: string[]
  try {
    names = await readdir(sshDir())
  } catch {
    return []
  }

  const candidates = names.filter(
    (n) =>
      !n.endsWith('.pub') &&
      !n.endsWith('.ppk') &&
      !['config', 'known_hosts', 'known_hosts.old', 'authorized_keys', 'agent.env'].includes(n)
  )

  const found: Identity[] = []
  for (const name of candidates) {
    const path = join(sshDir(), name)
    try {
      const info = await stat(path)
      // Real keys are small; skip directories and anything implausible.
      if (!info.isFile() || info.size > 64 * 1024) continue
      const text = await readFile(path, 'utf8')
      if (!/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text)) continue
      found.push({ path, type: keyType(name, text), encrypted: isEncrypted(text) })
    } catch {
      // Unreadable (permissions, binary) — not a usable identity.
    }
  }

  return found.sort((a, b) => {
    const ai = DEFAULT_KEY_NAMES.indexOf(basename(a.path))
    const bi = DEFAULT_KEY_NAMES.indexOf(basename(b.path))
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || a.path.localeCompare(b.path)
  })
}

/**
 * Parses ~/.ssh/config into concrete host entries so saved hosts can be
 * pre-filled from what the user already has.
 *
 * Supported: Host, HostName, User, Port, IdentityFile, and `Host *` defaults.
 * Not supported: Include, Match blocks, and token expansion (%h, %p) — hosts
 * that depend on those are still listed, just without the inherited settings.
 */
export async function parseSshConfig(): Promise<SshConfigHost[]> {
  let text: string
  try {
    text = await readFile(join(sshDir(), 'config'), 'utf8')
  } catch {
    return []
  }

  interface Block {
    aliases: string[]
    settings: Map<string, string[]>
  }
  const blocks: Block[] = []
  let current: Block | null = null
  let inMatch = false

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue

    const [keyword, ...rest] = line.split(/[\s=]+/)
    const key = keyword.toLowerCase()
    const value = rest.join(' ')

    if (key === 'host') {
      inMatch = false
      current = { aliases: rest, settings: new Map() }
      blocks.push(current)
      continue
    }
    if (key === 'match') {
      inMatch = true
      continue
    }
    if (inMatch || !current) continue

    const existing = current.settings.get(key) ?? []
    existing.push(value)
    current.settings.set(key, existing)
  }

  const wildcard = blocks.find((b) => b.aliases.includes('*'))
  const inherited = (key: string): string[] => wildcard?.settings.get(key) ?? []

  return blocks
    .filter((b) => !b.aliases.some((a) => a.includes('*') || a.includes('?')))
    .flatMap((b) =>
      b.aliases.map((alias) => {
        const get = (key: string): string | undefined =>
          b.settings.get(key)?.[0] ?? inherited(key)[0]
        const identities = [...(b.settings.get('identityfile') ?? []), ...inherited('identityfile')]
        const port = get('port')
        return {
          alias,
          hostname: get('hostname') ?? alias,
          user: get('user'),
          port: port ? Number(port) : undefined,
          identityFiles: identities.map(expandPath)
        } satisfies SshConfigHost
      })
    )
}

export function agentSocket(): string | undefined {
  return process.env.SSH_AUTH_SOCK
}
