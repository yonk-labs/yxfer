import { useEffect, useRef, useState } from 'react'

import type { SessionInfo } from '@shared/types'
import { crumbs } from '../format'

export default function Toolbar(props: {
  session: SessionInfo
  path: string
  loading: boolean
  selectionCount: number
  showHidden: boolean
  query: string
  onQueryChange: (value: string) => void
  /** Rows currently shown vs. rows in the directory, for the filter readout. */
  shown: number
  total: number
  /** False when the selection is empty or holds only folders. */
  canPreview: boolean
  onPreview: () => void
  onNavigate: (path: string) => void
  onUp: () => void
  onRefresh: () => void
  onNewFolder: () => void
  onUpload: () => void
  onDownload: () => void
  onDownloadTo: () => void
  onRename: () => void
  onDelete: () => void
  onToggleHidden: () => void
}): JSX.Element {
  const [editingPath, setEditingPath] = useState(false)
  const [draft, setDraft] = useState(props.path)
  const filterRef = useRef<HTMLInputElement>(null)

  useEffect(() => setDraft(props.path), [props.path])

  // Cmd/Ctrl+F jumps to the filter, Escape clears and leaves it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        filterRef.current?.focus()
        filterRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const caps = props.session.capabilities
  const hasSelection = props.selectionCount > 0

  return (
    <div className="toolbar">
      <div className="nav-row">
        <button className="icon-btn" title="Parent folder" onClick={props.onUp} disabled={props.path === '/'}>
          ↑
        </button>
        <button className="icon-btn" title="Refresh" onClick={props.onRefresh}>
          {props.loading ? <span className="spinner" /> : '⟳'}
        </button>

        {editingPath ? (
          <form
            className="path-edit"
            onSubmit={(e) => {
              e.preventDefault()
              setEditingPath(false)
              if (draft.trim()) props.onNavigate(draft.trim())
            }}
          >
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => setEditingPath(false)}
              spellCheck={false}
            />
          </form>
        ) : (
          <nav className="breadcrumbs" onDoubleClick={() => setEditingPath(true)} title="Double-click to type a path">
            {crumbs(props.path).map((c, i, all) => (
              <span key={c.path}>
                <button className="crumb" onClick={() => props.onNavigate(c.path)}>
                  {c.label}
                </button>
                {/* The root crumb is already "/", so it needs no separator. */}
                {i < all.length - 1 && c.path !== '/' && <span className="crumb-sep">/</span>}
              </span>
            ))}
          </nav>
        )}
      </div>

      <div className="action-row">
        <button onClick={props.onPreview} disabled={!props.canPreview} title="Preview (Space)">
          Preview
        </button>
        <button onClick={props.onUpload}>Upload…</button>
        <button onClick={props.onDownload} disabled={!hasSelection}>
          Download
        </button>
        <button onClick={props.onDownloadTo} disabled={!hasSelection}>
          Download to…
        </button>
        <span className="sep" />
        <button onClick={props.onNewFolder} disabled={!caps.mkdir}>
          New folder
        </button>
        <button onClick={props.onRename} disabled={!caps.rename || props.selectionCount !== 1}>
          Rename
        </button>
        <button className="danger-text" onClick={props.onDelete} disabled={!caps.remove || !hasSelection}>
          Delete
        </button>
        <span className="spacer" />

        {props.query.trim() !== '' && (
          <span className="filter-count">
            {props.shown} of {props.total}
          </span>
        )}
        <div className="filter">
          <input
            ref={filterRef}
            className="filter-input"
            value={props.query}
            placeholder="Filter…"
            spellCheck={false}
            onChange={(e) => props.onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                props.onQueryChange('')
                e.currentTarget.blur()
              }
            }}
          />
          {props.query !== '' && (
            <button
              className="filter-clear"
              title="Clear filter"
              onClick={() => props.onQueryChange('')}
            >
              ✕
            </button>
          )}
        </div>

        <label className="checkbox">
          <input type="checkbox" checked={props.showHidden} onChange={props.onToggleHidden} />
          Hidden files
        </label>
      </div>
    </div>
  )
}
