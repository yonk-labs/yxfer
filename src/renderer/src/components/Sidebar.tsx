import type { Profile, S3Config, SessionInfo, SftpConfig } from '@shared/types'

function subtitle(profile: Profile): string {
  if (profile.kind === 'sftp') {
    const c = profile.config as SftpConfig
    return `${c.username}@${c.host}${c.port !== 22 ? `:${c.port}` : ''}`
  }
  const c = profile.config as S3Config
  const label = profile.kind === 'b2' ? 'b2' : 's3'
  return `${label}://${c.bucket}${c.prefix ? `/${c.prefix.replace(/^\/+/, '')}` : ''}`
}

export default function Sidebar(props: {
  profiles: Profile[]
  sessions: SessionInfo[]
  connectingId: string | null
  onConnect: (p: Profile) => void
  onEdit: (p: Profile) => void
  onDelete: (p: Profile) => void
  onNew: () => void
}): JSX.Element {
  const connectedProfileIds = new Set(props.sessions.map((s) => s.profileId))

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span>Hosts</span>
        <button className="icon-btn" title="New connection" onClick={props.onNew}>
          +
        </button>
      </div>

      <ul className="host-list">
        {props.profiles.map((p) => {
          const connected = connectedProfileIds.has(p.id)
          return (
            <li key={p.id} className={connected ? 'connected' : ''}>
              <button
                className="host"
                onDoubleClick={() => props.onConnect(p)}
                onClick={() => props.onConnect(p)}
                disabled={props.connectingId === p.id}
              >
                <span className="host-name">
                  {connected && <span className="dot" />}
                  {p.name}
                </span>
                <span className="host-sub">
                  {props.connectingId === p.id ? 'Connecting…' : subtitle(p)}
                </span>
              </button>
              <div className="host-actions">
                <button className="icon-btn" title="Edit" onClick={() => props.onEdit(p)}>
                  ✎
                </button>
                <button className="icon-btn" title="Remove" onClick={() => props.onDelete(p)}>
                  🗑
                </button>
              </div>
            </li>
          )
        })}

        {props.profiles.length === 0 && (
          <li className="host-empty">
            No saved hosts yet.
            <button className="link" onClick={props.onNew}>
              Add one
            </button>
          </li>
        )}
      </ul>
    </aside>
  )
}
