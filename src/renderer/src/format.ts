const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function bytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), UNITS.length - 1)
  const value = n / 1024 ** i
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${UNITS[i]}`
}

export function rate(bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return '—'
  return `${bytes(bytesPerSecond)}/s`
}

export function eta(remaining: number, bytesPerSecond: number): string {
  if (bytesPerSecond <= 0 || remaining <= 0) return ''
  const secs = Math.round(remaining / bytesPerSecond)
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
}

export function when(ms: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? { hour: '2-digit', minute: '2-digit' } : { year: 'numeric' })
  })
}

/** Splits an absolute POSIX path into cumulative breadcrumb segments. */
export function crumbs(path: string): Array<{ label: string; path: string }> {
  const parts = path.split('/').filter(Boolean)
  const out = [{ label: '/', path: '/' }]
  let cursor = ''
  for (const part of parts) {
    cursor += `/${part}`
    out.push({ label: part, path: cursor })
  }
  return out
}

export type SortKey = 'name' | 'size' | 'mtime' | 'created' | 'accessed' | 'mode'
export type SortDir = 'asc' | 'desc'

export interface Sort {
  key: SortKey
  dir: SortDir
}

/** Clicking a column sorts ascending; clicking the active one flips it. */
export function nextSort(current: Sort, key: SortKey): Sort {
  if (current.key !== key) {
    // Dates and sizes are most useful largest-first on the first click.
    return { key, dir: key === 'name' ? 'asc' : 'desc' }
  }
  return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
}

/**
 * Every form of a timestamp the filter should match, so all of
 * "2026-07-29", "2026-07", "jul 29", "9:25 pm" and "2026" find the same file.
 */
function dateTokens(ms?: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const iso = new Date(ms - d.getTimezoneOffset() * 60_000).toISOString()
  return [
    iso.slice(0, 10), // 2026-07-29
    iso.slice(0, 7), // 2026-07
    iso.slice(11, 16), // 14:25
    d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
    d.toLocaleDateString(undefined, { month: 'long' }),
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  ].join(' ')
}

/**
 * Lowercased text the filter searches: the name plus every date the entry
 * carries, so typing a date narrows the listing the same way a name does.
 */
export function searchText(entry: {
  name: string
  mtime: number
  created?: number
  accessed?: number
}): string {
  return [
    entry.name,
    dateTokens(entry.mtime),
    dateTokens(entry.created),
    dateTokens(entry.accessed)
  ]
    .join(' ')
    .toLowerCase()
}

export function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const i = trimmed.lastIndexOf('/')
  return i <= 0 ? '/' : trimmed.slice(0, i)
}

export function joinRemote(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${name}`.replace(/\/+/g, '/')
}
