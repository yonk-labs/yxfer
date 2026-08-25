import { useState } from 'react'

import type { Transfer } from '@shared/types'
import { bytes, eta, rate } from '../format'

function stateLabel(t: Transfer): string {
  switch (t.state) {
    case 'queued':
      return 'Queued'
    case 'running':
      return `${rate(t.rate)}${t.total ? ` · ${eta(t.total - t.bytes, t.rate)}` : ''}`
    case 'done':
      return 'Done'
    case 'canceled':
      return 'Canceled'
    case 'error':
      return t.error ?? 'Failed'
  }
}

export default function TransferPanel(props: {
  transfers: Transfer[]
  activeCount: number
  onCancel: (id: string) => void
  onCancelAll: () => void
  onClear: () => void
  onReveal: (path: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)

  const totals = props.transfers
    .filter((t) => t.state === 'running')
    .reduce(
      (acc, t) => ({ bytes: acc.bytes + t.bytes, total: acc.total + t.total, rate: acc.rate + t.rate }),
      { bytes: 0, total: 0, rate: 0 }
    )

  const recent = [...props.transfers].reverse().slice(0, 200)

  return (
    <section className={`transfers ${open ? 'open' : ''}`}>
      <button className="transfers-head" onClick={() => setOpen((v) => !v)}>
        <span className="chevron">{open ? '▾' : '▸'}</span>
        <span>Transfers</span>
        {props.activeCount > 0 ? (
          <span className="badge">{props.activeCount}</span>
        ) : (
          <span className="muted">idle</span>
        )}
        {totals.rate > 0 && (
          <span className="muted">
            {bytes(totals.bytes)}
            {totals.total > 0 && ` / ${bytes(totals.total)}`} · {rate(totals.rate)}
          </span>
        )}
        <span className="spacer" />
        {props.activeCount > 0 && (
          <span
            className="link"
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation()
              props.onCancelAll()
            }}
            onKeyDown={(e) => e.key === 'Enter' && props.onCancelAll()}
          >
            Cancel all
          </span>
        )}
        <span
          className="link"
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation()
            props.onClear()
          }}
          onKeyDown={(e) => e.key === 'Enter' && props.onClear()}
        >
          Clear finished
        </span>
      </button>

      {open && (
        <ul className="transfer-list">
          {recent.length === 0 && <li className="transfer-empty">Nothing transferred yet.</li>}
          {recent.map((t) => {
            const pct = t.total > 0 ? Math.min(100, (t.bytes / t.total) * 100) : 0
            return (
              <li key={t.id} className={`transfer ${t.state}`}>
                <span className="arrow">{t.direction === 'upload' ? '↑' : '↓'}</span>
                <span className="transfer-name" title={t.direction === 'upload' ? t.localPath : t.remotePath}>
                  {t.name}
                </span>
                <span className="progress">
                  <span className="progress-bar" style={{ width: `${pct}%` }} />
                </span>
                <span className="transfer-size">
                  {t.state === 'running' && t.total > 0
                    ? `${bytes(t.bytes)} / ${bytes(t.total)}`
                    : bytes(t.total || t.bytes)}
                </span>
                <span className="transfer-state">{stateLabel(t)}</span>
                {t.state === 'running' || t.state === 'queued' ? (
                  <button className="icon-btn" title="Cancel" onClick={() => props.onCancel(t.id)}>
                    ✕
                  </button>
                ) : t.state === 'done' && t.direction === 'download' ? (
                  <button className="icon-btn" title="Show in Finder" onClick={() => props.onReveal(t.localPath)}>
                    ↗
                  </button>
                ) : (
                  <span className="icon-btn placeholder" />
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
