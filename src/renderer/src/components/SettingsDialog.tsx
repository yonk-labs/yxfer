import { useEffect, useState } from 'react'

import type { AppSettings } from '../../../preload'
import Modal from './Modal'

const api = window.yxfer

export default function SettingsDialog(props: {
  onClose: () => void
  onConfirmDeleteChange: (value: boolean) => void
}): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [hostKeys, setHostKeys] = useState<Array<{ host: string; fingerprint: string }>>([])

  useEffect(() => {
    void (async () => {
      setSettings(await api.settings.get())
      setHostKeys(await api.hostKeys.list())
    })()
  }, [])

  const patch = async (next: Partial<AppSettings>): Promise<void> => {
    const saved = await api.settings.set(next)
    setSettings({ ...saved, effectiveDownloadDir: settings?.effectiveDownloadDir ?? '' })
    setSettings(await api.settings.get())
  }

  return (
    <Modal title="Settings" wide onClose={props.onClose}>
      {settings && (
        <>
          <div className="field-row">
            <label className="field grow">
              <span>Download folder</span>
              <input readOnly value={settings.effectiveDownloadDir} spellCheck={false} />
            </label>
            <button
              type="button"
              className="align-end"
              onClick={async () => {
                const dir = await api.dialog.pickFolder()
                if (dir) void patch({ downloadDir: dir })
              }}
            >
              Change…
            </button>
            <button
              type="button"
              className="align-end"
              onClick={() => void patch({ downloadDir: '' })}
            >
              Reset
            </button>
          </div>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={settings.confirmDelete}
              onChange={(e) => {
                void patch({ confirmDelete: e.target.checked })
                props.onConfirmDeleteChange(e.target.checked)
              }}
            />
            Ask before deleting remote files
          </label>

          <h3 className="section">Known hosts</h3>
          <p className="note">
            yxfer records each host key the first time it connects and refuses to connect if it
            later changes. Forget a host to accept a new key.
          </p>
          <ul className="hostkeys">
            {hostKeys.length === 0 && <li className="muted">No hosts recorded yet.</li>}
            {hostKeys.map((h) => (
              <li key={h.host}>
                <span className="mono">{h.host}</span>
                <span className="mono muted">{h.fingerprint}</span>
                <button
                  type="button"
                  onClick={() => {
                    void api.hostKeys.forget(h.host)
                    setHostKeys((prev) => prev.filter((x) => x.host !== h.host))
                  }}
                >
                  Forget
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="modal-actions">
        <button type="button" className="primary" onClick={props.onClose}>
          Done
        </button>
      </div>
    </Modal>
  )
}
