import { useCallback, useEffect, useState } from 'react'

import type { PreviewPayload } from '@shared/types'
import { bytes } from '../format'

const api = window.yxfer

export default function PreviewModal(props: {
  sessionId: string
  /** Paths that can be stepped through with ← / →. */
  paths: string[]
  index: number
  onIndexChange: (next: number) => void
  onDownload: (path: string) => void
  onClose: () => void
}): JSX.Element {
  const path = props.paths[props.index]

  const [payload, setPayload] = useState<PreviewPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // Sticky across files: if you asked for text, keep showing text.
  const [textOnly, setTextOnly] = useState(false)

  useEffect(() => {
    let canceled = false
    setLoading(true)
    setError(null)

    void api.preview
      .read(props.sessionId, path, textOnly)
      .then((result) => {
        if (!canceled) setPayload(result)
      })
      .catch((err: unknown) => {
        if (!canceled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!canceled) setLoading(false)
      })

    return () => {
      canceled = true
    }
  }, [props.sessionId, path, textOnly])

  const step = useCallback(
    (delta: number) => {
      const next = props.index + delta
      if (next >= 0 && next < props.paths.length) props.onIndexChange(next)
    },
    [props]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
      else if (e.key === 'ArrowRight') step(1)
      else if (e.key === 'ArrowLeft') step(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props, step])

  return (
    <div className="overlay" onMouseDown={props.onClose}>
      <div className="preview" onMouseDown={(e) => e.stopPropagation()} role="dialog">
        <header className="preview-head">
          <div className="preview-title">
            <span className="preview-name" title={path}>
              {payload?.name ?? path.slice(path.lastIndexOf('/') + 1)}
            </span>
            <span className="muted">
              {payload ? bytes(payload.size) : ''}
              {payload?.truncated && ' · showing the first part'}
            </span>
          </div>

          {props.paths.length > 1 && (
            <div className="preview-nav">
              <button className="icon-btn" onClick={() => step(-1)} disabled={props.index === 0}>
                ‹
              </button>
              <span className="muted">
                {props.index + 1} / {props.paths.length}
              </span>
              <button
                className="icon-btn"
                onClick={() => step(1)}
                disabled={props.index === props.paths.length - 1}
              >
                ›
              </button>
            </div>
          )}

          <label className="checkbox">
            <input
              type="checkbox"
              checked={textOnly}
              onChange={(e) => setTextOnly(e.target.checked)}
            />
            View as text
          </label>

          <button onClick={() => props.onDownload(path)}>Download</button>
          <button className="icon-btn" title="Close (Esc)" onClick={props.onClose}>
            ✕
          </button>
        </header>

        <div className={`preview-body ${payload?.kind === 'image' ? 'is-image' : ''}`}>
          {loading && <div className="preview-note">Loading…</div>}

          {!loading && error && <div className="preview-note error">{error}</div>}

          {!loading && !error && payload?.kind === 'image' && (
            <img className="preview-image" src={payload.dataUrl} alt={payload.name} />
          )}

          {!loading && !error && payload?.kind === 'text' && (
            <pre className="preview-text">
              {payload.text}
              {payload.truncated && (
                <span className="preview-cut">
                  {'\n\n'}— truncated, download the file to see the rest —
                </span>
              )}
            </pre>
          )}

          {!loading && !error && payload?.kind === 'binary' && (
            <div className="preview-note">
              {payload.reason}
              <div className="preview-actions">
                {!textOnly && <button onClick={() => setTextOnly(true)}>View as text</button>}
                <button className="primary" onClick={() => props.onDownload(path)}>
                  Download
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
