import type { PreviewPayload } from '@shared/types'
import { rpath } from './providers/provider'
import { sessions } from './sessions'

/** Images are inlined as data: URLs, so keep the ceiling modest. */
const IMAGE_MAX = 24 * 1024 * 1024

/** Text beyond this is shown truncated rather than freezing the renderer. */
const TEXT_MAX = 1024 * 1024

/** Bytes sampled to decide whether an unknown extension holds text. */
const SNIFF_BYTES = 8 * 1024

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  svg: 'image/svg+xml'
}

/** Extensions we treat as text without sniffing the contents. */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'rst', 'log', 'csv', 'tsv',
  'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'env',
  'xml', 'html', 'htm', 'css', 'scss', 'less',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte',
  'py', 'rb', 'php', 'pl', 'lua', 'r',
  'go', 'rs', 'java', 'kt', 'scala', 'swift',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'm', 'mm',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'sql', 'graphql', 'proto', 'tf', 'tfvars',
  'gitignore', 'gitattributes', 'dockerignore', 'editorconfig', 'patch', 'diff'
])

/** Extension-less files that are conventionally text. */
const TEXT_FILENAMES = new Set([
  'dockerfile', 'makefile', 'rakefile', 'gemfile', 'procfile', 'brewfile',
  'license', 'readme', 'changelog', 'authors', 'notice', 'copying',
  'known_hosts', 'authorized_keys', 'hosts', 'crontab', '.bashrc', '.zshrc', '.profile'
])

function extensionOf(name: string): string {
  const i = name.lastIndexOf('.')
  // A leading dot is part of the name (".env"), not an extension separator.
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase()
}

/**
 * Decides whether a buffer is text. A NUL byte means binary; otherwise the
 * bytes must round-trip through UTF-8 without producing replacement
 * characters, which rules out most binary formats.
 */
function looksLikeText(buf: Buffer): boolean {
  const sample = buf.subarray(0, SNIFF_BYTES)
  if (sample.includes(0)) return false
  if (sample.length === 0) return true

  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(sample)
  const replacements = (decoded.match(/�/g) ?? []).length
  // Allow a couple, since the sample can end mid-character.
  return replacements <= 2
}

/** Strips control characters so raw bytes stay readable in text-only mode. */
function toReadableText(buf: Buffer): string {
  return buf
    .toString('utf8')
    .replace(/\r\n/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, String.fromCharCode(183))
}

export interface PreviewOptions {
  /** Force a text rendering regardless of the detected type. */
  asText?: boolean
}

/**
 * Builds a preview payload for one remote file. Reads at most a capped number
 * of bytes, so previewing a huge file is cheap.
 */
export async function buildPreview(
  sessionId: string,
  path: string,
  options: PreviewOptions = {}
): Promise<PreviewPayload> {
  const provider = sessions.provider(sessionId)
  const entry = await provider.stat(path)
  const name = rpath.basename(path)

  const base = { name, path, size: entry.size, truncated: false }

  if (entry.type === 'dir') {
    return { ...base, kind: 'binary', reason: 'Folders cannot be previewed.' }
  }

  const ext = extensionOf(name)
  const bare = name.toLowerCase()
  const imageMime = IMAGE_MIME[ext]

  // ---- image -----------------------------------------------------------
  if (imageMime && !options.asText) {
    if (entry.size > IMAGE_MAX) {
      return {
        ...base,
        kind: 'binary',
        reason: `Image is ${Math.round(entry.size / 1024 / 1024)} MB — too large to preview (limit ${IMAGE_MAX / 1024 / 1024} MB).`
      }
    }
    const buf = await provider.read(path, Math.min(entry.size, IMAGE_MAX))
    return {
      ...base,
      kind: 'image',
      mime: imageMime,
      dataUrl: `data:${imageMime};base64,${buf.toString('base64')}`
    }
  }

  // ---- text ------------------------------------------------------------
  const wanted = Math.min(entry.size, TEXT_MAX)
  const buf = entry.size === 0 ? Buffer.alloc(0) : await provider.read(path, wanted)
  const truncated = entry.size > wanted

  const knownText = TEXT_EXTENSIONS.has(ext) || TEXT_FILENAMES.has(bare) || bare.startsWith('.')

  if (options.asText || knownText || looksLikeText(buf)) {
    return {
      ...base,
      kind: 'text',
      truncated,
      text: toReadableText(buf),
      mime: 'text/plain'
    }
  }

  return {
    ...base,
    kind: 'binary',
    reason: 'This looks like a binary file. Use “View as text” to see it anyway.'
  }
}
