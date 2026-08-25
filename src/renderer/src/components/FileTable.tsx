import { useRef, useState } from 'react'

import type { Capabilities, RemoteEntry } from '@shared/types'
import { bytes, when, type Sort, type SortKey } from '../format'

const api = window.yxfer

/**
 * `needs` gates a column on a provider capability, so a backend that cannot
 * supply a value never shows a permanently empty column.
 */
const COLUMNS: Array<{
  key: SortKey
  label: string
  className: string
  needs?: 'createdTime' | 'accessedTime' | 'permissions'
}> = [
  { key: 'name', label: 'Name', className: 'name' },
  { key: 'size', label: 'Size', className: 'size' },
  { key: 'created', label: 'Created', className: 'date', needs: 'createdTime' },
  { key: 'mtime', label: 'Modified', className: 'date' },
  { key: 'accessed', label: 'Accessed', className: 'date', needs: 'accessedTime' },
  { key: 'mode', label: 'Mode', className: 'mode', needs: 'permissions' }
]

function icon(entry: RemoteEntry): string {
  if (entry.type === 'dir') return '📁'
  if (entry.type === 'symlink') return '🔗'
  return '📄'
}

/** Pulls absolute paths out of a drop, which Electron 32+ hides behind webUtils. */
function pathsFromDrop(dataTransfer: DataTransfer): string[] {
  return Array.from(dataTransfer.files)
    .map((f) => {
      try {
        return api.pathForFile(f)
      } catch {
        return ''
      }
    })
    .filter(Boolean)
}

export default function FileTable(props: {
  sessionId: string
  entries: RemoteEntry[]
  /** Provider capabilities; columns a backend cannot fill are hidden. */
  capabilities: Capabilities
  sort: Sort
  onSort: (key: SortKey) => void
  /** Changes the empty-state wording so a filter never reads as an empty folder. */
  filterActive: boolean
  loading: boolean
  selection: Set<string>
  onSelectionChange: (next: Set<string>) => void
  onOpenDir: (path: string) => void
  onPreview: (path: string) => void
  onDropFiles: (localPaths: string[]) => void
  onDownload: (remotePaths: string[]) => void
}): JSX.Element {
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [dropActive, setDropActive] = useState(false)
  const lastIndex = useRef<number | null>(null)

  const columns = COLUMNS.filter((c) => !c.needs || props.capabilities[c.needs])

  /** Renders one cell, keeping header order and body order in lockstep. */
  const cell = (entry: RemoteEntry, key: SortKey): JSX.Element | string => {
    switch (key) {
      case 'name':
        return (
          <>
            <span className="icon">{icon(entry)}</span>
            {entry.name}
          </>
        )
      case 'size':
        return entry.type === 'dir' ? '—' : bytes(entry.size)
      case 'created':
        return when(entry.created ?? 0)
      case 'mtime':
        return when(entry.mtime)
      case 'accessed':
        return when(entry.accessed ?? 0)
      case 'mode':
        return entry.modeString ?? ''
    }
  }

  const select = (entry: RemoteEntry, index: number, e: React.MouseEvent): void => {
    const next = new Set(props.selection)

    if (e.shiftKey && lastIndex.current !== null) {
      const [from, to] = [lastIndex.current, index].sort((a, b) => a - b)
      for (let i = from; i <= to; i++) next.add(props.entries[i].path)
    } else if (e.metaKey || e.ctrlKey) {
      if (next.has(entry.path)) next.delete(entry.path)
      else next.add(entry.path)
      lastIndex.current = index
    } else {
      next.clear()
      next.add(entry.path)
      lastIndex.current = index
    }
    props.onSelectionChange(next)
  }

  const dragOut = (entry: RemoteEntry, e: React.DragEvent): void => {
    e.preventDefault()
    // Drag whatever is selected; a drag on an unselected row drags just it.
    const paths = props.selection.has(entry.path) ? [...props.selection] : [entry.path]
    api.startDrag(props.sessionId, paths)
  }

  return (
    <div
      className={`file-pane ${dropActive ? 'drop-active' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDropActive(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDropActive(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDropActive(false)
        setDropTarget(null)
        const paths = pathsFromDrop(e.dataTransfer)
        if (paths.length) props.onDropFiles(paths)
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onSelectionChange(new Set())
      }}
    >
      <table className="files">
        <thead>
          <tr>
            {columns.map((col) => {
              const active = props.sort.key === col.key
              return (
                <th
                  key={col.key}
                  className={`col-${col.className} ${active ? 'sorted' : ''}`}
                  aria-sort={active ? (props.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  <button className="col-sort" onClick={() => props.onSort(col.key)}>
                    {col.label}
                    <span className="sort-arrow">
                      {active ? (props.sort.dir === 'asc' ? '▲' : '▼') : ''}
                    </span>
                  </button>
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {props.entries.map((entry, index) => (
            <tr
              key={entry.path}
              className={[
                props.selection.has(entry.path) ? 'selected' : '',
                dropTarget === entry.path ? 'drop-into' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              draggable
              onDragStart={(e) => dragOut(entry, e)}
              onClick={(e) => select(entry, index, e)}
              onDoubleClick={() => {
                // Opening a folder navigates; opening a file previews it.
                // Downloading stays an explicit action (button, or drag out).
                if (entry.type === 'dir') props.onOpenDir(entry.path)
                else props.onPreview(entry.path)
              }}
              onDragOver={(e) => {
                if (entry.type !== 'dir') return
                e.preventDefault()
                e.stopPropagation()
                setDropTarget(entry.path)
              }}
              onDragLeave={() => setDropTarget((p) => (p === entry.path ? null : p))}
              onDrop={(e) => {
                if (entry.type !== 'dir') return
                e.preventDefault()
                e.stopPropagation()
                setDropTarget(null)
                setDropActive(false)
                const paths = pathsFromDrop(e.dataTransfer)
                if (!paths.length) return
                // Upload straight into the folder that was dropped on.
                void api.xfer.upload(props.sessionId, paths, entry.path)
              }}
            >
              {columns.map((col) => (
                <td key={col.key} className={`col-${col.className}`}>
                  {cell(entry, col.key)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {props.entries.length === 0 && !props.loading && (
        <div className="pane-empty">
          {props.filterActive
            ? 'Nothing here matches the filter.'
            : 'Empty folder — drop files here to upload.'}
        </div>
      )}
      {dropActive && <div className="drop-hint">Drop to upload here</div>}
    </div>
  )
}
