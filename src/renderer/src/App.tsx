import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { Profile, RemoteEntry, SessionInfo, Transfer } from '@shared/types'
import ConnectionDialog from './components/ConnectionDialog'
import FileTable from './components/FileTable'
import Modal from './components/Modal'
import PreviewModal from './components/PreviewModal'
import SettingsDialog from './components/SettingsDialog'
import Sidebar from './components/Sidebar'
import Toolbar from './components/Toolbar'
import TransferPanel from './components/TransferPanel'
import { joinRemote, nextSort, parentOf, searchText, type Sort } from './format'

const api = window.yxfer

export interface Toast {
  id: number
  kind: 'info' | 'error'
  message: string
}

export default function App(): JSX.Element {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [cwd, setCwd] = useState<Record<string, string>>({})
  const [entries, setEntries] = useState<RemoteEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [showHidden, setShowHidden] = useState(false)
  const [sort, setSort] = useState<Sort>({ key: 'name', dir: 'asc' })
  const [query, setQuery] = useState('')
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(true)
  const [connecting, setConnecting] = useState<string | null>(null)
  const [editing, setEditing] = useState<Profile | 'new' | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [prompt, setPrompt] = useState<null | {
    title: string
    label: string
    initial: string
    confirmLabel: string
    onSubmit: (value: string) => void
  }>(null)
  const [confirm, setConfirm] = useState<null | {
    title: string
    body: string
    confirmLabel: string
    danger?: boolean
    onConfirm: () => void
  }>(null)
  const [toasts, setToasts] = useState<Toast[]>([])

  const toastSeq = useRef(0)

  const toast = useCallback((message: string, kind: Toast['kind'] = 'info') => {
    const id = ++toastSeq.current
    setToasts((prev) => [...prev, { id, kind, message }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 6000)
  }, [])

  const activeSession = sessions.find((s) => s.id === activeId) ?? null
  const path = activeId ? (cwd[activeId] ?? '/') : ''

  // ---- data loading ----------------------------------------------------

  const refresh = useCallback(
    async (sessionId: string, dir: string) => {
      setLoading(true)
      try {
        const list = await api.fs.list(sessionId, dir)
        setEntries(list)
        setSelection(new Set())
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error')
        setEntries([])
      } finally {
        setLoading(false)
      }
    },
    [toast]
  )

  const navigate = useCallback(
    (dir: string) => {
      if (!activeId) return
      setCwd((prev) => ({ ...prev, [activeId]: dir }))
      void refresh(activeId, dir)
    },
    [activeId, refresh]
  )

  useEffect(() => {
    void (async () => {
      setProfiles(await api.profiles.list())
      const settings = await api.settings.get()
      setShowHidden(settings.showHidden)
      setConfirmDelete(settings.confirmDelete)
      setTransfers(await api.xfer.list())
    })()
  }, [])

  useEffect(() => {
    return api.onEvent((event) => {
      if (event.type === 'transfer') {
        setTransfers((prev) => {
          const i = prev.findIndex((t) => t.id === event.transfer.id)
          if (i === -1) return [...prev, event.transfer]
          const next = [...prev]
          next[i] = event.transfer
          return next
        })
      } else if (event.type === 'session-closed') {
        setSessions((prev) => prev.filter((s) => s.id !== event.sessionId))
        setActiveId((prev) => (prev === event.sessionId ? null : prev))
        toast(event.reason ? `Disconnected: ${event.reason}` : 'Disconnected', 'error')
      } else if (event.type === 'notice') {
        toast(event.message, event.kind)
      }
    })
  }, [toast])

  // Refresh the listing when an upload into the current directory finishes.
  const doneCount = transfers.filter((t) => t.state === 'done').length
  useEffect(() => {
    if (!activeId || !path) return
    const timer = setTimeout(() => void refresh(activeId, path), 250)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doneCount])

  // ---- connection actions ---------------------------------------------

  const connect = useCallback(
    async (profile: Profile, secret?: string) => {
      setConnecting(profile.id)
      try {
        const info = await api.session.open(profile.id, secret)
        setSessions((prev) => [...prev.filter((s) => s.id !== info.id), info])
        setActiveId(info.id)
        setCwd((prev) => ({ ...prev, [info.id]: info.home }))
        await refresh(info.id, info.home)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // A profile whose secret is not stored asks for it once, in memory only.
        if (/no password supplied|no usable credentials/i.test(message)) {
          setPrompt({
            title: `Credentials for ${profile.name}`,
            label: profile.kind === 'sftp' ? 'Password or key passphrase' : 'Secret access key',
            initial: '',
            confirmLabel: 'Connect',
            onSubmit: (value) => void connect(profile, value)
          })
        } else {
          toast(message, 'error')
        }
      } finally {
        setConnecting(null)
      }
    },
    [refresh, toast]
  )

  const disconnect = useCallback(
    async (sessionId: string) => {
      await api.session.close(sessionId)
      setSessions((prev) => prev.filter((s) => s.id !== sessionId))
      if (activeId === sessionId) {
        setActiveId(null)
        setEntries([])
      }
    },
    [activeId]
  )

  // ---- transfer actions -------------------------------------------------

  const uploadPaths = useCallback(
    async (localPaths: string[]) => {
      if (!activeId || localPaths.length === 0) return
      try {
        await api.xfer.upload(activeId, localPaths, path)
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error')
      }
    },
    [activeId, path, toast]
  )

  const downloadSelected = useCallback(
    async (destination?: string) => {
      if (!activeId || selection.size === 0) return
      try {
        await api.xfer.download(activeId, [...selection], destination)
        toast(`Downloading ${selection.size} item${selection.size === 1 ? '' : 's'}`)
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error')
      }
    },
    [activeId, selection, toast]
  )

  const deleteSelected = useCallback(() => {
    if (!activeId || selection.size === 0) return
    const targets = [...selection]
    const run = async (): Promise<void> => {
      for (const target of targets) {
        try {
          await api.fs.remove(activeId, target, true)
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err), 'error')
        }
      }
      await refresh(activeId, path)
    }

    if (!confirmDelete) {
      void run()
      return
    }
    setConfirm({
      title: `Delete ${targets.length} item${targets.length === 1 ? '' : 's'}?`,
      body: 'This permanently removes the files on the remote host. Directories are deleted with their contents.',
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: () => void run()
    })
  }, [activeId, confirmDelete, path, refresh, selection, toast])

  const makeDirectory = useCallback(() => {
    if (!activeId) return
    setPrompt({
      title: 'New folder',
      label: 'Folder name',
      initial: '',
      confirmLabel: 'Create',
      onSubmit: (name) => {
        if (!name.trim()) return
        void (async () => {
          try {
            await api.fs.mkdir(activeId, joinRemote(path, name.trim()))
            await refresh(activeId, path)
          } catch (err) {
            toast(err instanceof Error ? err.message : String(err), 'error')
          }
        })()
      }
    })
  }, [activeId, path, refresh, toast])

  const renameSelected = useCallback(() => {
    if (!activeId || selection.size !== 1) return
    const target = [...selection][0]
    const current = target.slice(target.lastIndexOf('/') + 1)
    setPrompt({
      title: 'Rename',
      label: 'New name',
      initial: current,
      confirmLabel: 'Rename',
      onSubmit: (name) => {
        if (!name.trim() || name === current) return
        void (async () => {
          try {
            await api.fs.rename(activeId, target, joinRemote(path, name.trim()))
            await refresh(activeId, path)
          } catch (err) {
            toast(err instanceof Error ? err.message : String(err), 'error')
          }
        })()
      }
    })
  }, [activeId, path, refresh, selection, toast])

  // ---- profile actions --------------------------------------------------

  const saveProfile = useCallback(
    async (input: Omit<Profile, 'id' | 'createdAt'> & { id?: string }, secret?: string | null) => {
      try {
        const saved = await api.profiles.save(input)
        if (secret !== undefined) {
          try {
            await api.profiles.setSecret(saved.id, secret)
          } catch (err) {
            toast(err instanceof Error ? err.message : String(err), 'error')
          }
        }
        setProfiles(await api.profiles.list())
        setEditing(null)
        return saved
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error')
        return null
      }
    },
    [toast]
  )

  const deleteProfile = useCallback(
    (profile: Profile) => {
      setConfirm({
        title: `Remove “${profile.name}”?`,
        body: 'The saved connection and any stored password are deleted. Nothing on the remote host changes.',
        confirmLabel: 'Remove',
        danger: true,
        onConfirm: () => {
          void (async () => {
            await api.profiles.remove(profile.id)
            setProfiles(await api.profiles.list())
          })()
        }
      })
    },
    []
  )

  // ---- derived ----------------------------------------------------------

  const afterHidden = useMemo(
    () => (showHidden ? entries : entries.filter((e) => !e.name.startsWith('.'))),
    [entries, showHidden]
  )

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const filtered = needle
      ? afterHidden.filter((e) => searchText(e).includes(needle))
      : afterHidden

    const direction = sort.dir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      // Folders stay grouped above files regardless of the active column.
      if (a.type === 'dir' && b.type !== 'dir') return -1
      if (b.type === 'dir' && a.type !== 'dir') return 1

      switch (sort.key) {
        case 'size':
          return (a.size - b.size) * direction
        case 'mtime':
          return (a.mtime - b.mtime) * direction
        case 'created':
          return ((a.created ?? 0) - (b.created ?? 0)) * direction
        case 'accessed':
          return ((a.accessed ?? 0) - (b.accessed ?? 0)) * direction
        case 'mode':
          return (a.modeString ?? '').localeCompare(b.modeString ?? '') * direction
        default:
          return a.name.localeCompare(b.name, undefined, { numeric: true }) * direction
      }
    })
  }, [afterHidden, query, sort])

  const activeTransfers = transfers.filter((t) => t.state === 'running' || t.state === 'queued')

  /** Preview steps through files only; folders are navigated, not previewed. */
  const previewablePaths = useMemo(
    () => visible.filter((e) => e.type !== 'dir').map((e) => e.path),
    [visible]
  )

  const openPreview = useCallback(
    (path?: string) => {
      const target = path ?? [...selection].find((p) => previewablePaths.includes(p))
      if (!target) return
      const index = previewablePaths.indexOf(target)
      if (index !== -1) setPreviewIndex(index)
    },
    [previewablePaths, selection]
  )

  // Space previews the selection, the way Quick Look does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if (e.key === ' ' && previewIndex === null && selection.size > 0) {
        e.preventDefault()
        openPreview()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openPreview, previewIndex, selection.size])

  return (
    <div className="app">
      <header className="titlebar">
        <span className="wordmark">yxfer</span>
        <div className="tabs">
          {sessions.map((s) => (
            <button
              key={s.id}
              className={`tab ${s.id === activeId ? 'active' : ''}`}
              onClick={() => {
                setActiveId(s.id)
                void refresh(s.id, cwd[s.id] ?? s.home)
              }}
            >
              <span className="dot" />
              {s.name}
              <span
                className="tab-close"
                role="button"
                tabIndex={0}
                title="Disconnect"
                onClick={(e) => {
                  e.stopPropagation()
                  void disconnect(s.id)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void disconnect(s.id)
                }}
              >
                ✕
              </span>
            </button>
          ))}
        </div>
        <button className="icon-btn" title="Settings" onClick={() => setShowSettings(true)}>
          ⚙
        </button>
      </header>

      <div className="body">
        <Sidebar
          profiles={profiles}
          sessions={sessions}
          connectingId={connecting}
          onConnect={(p) => void connect(p)}
          onEdit={(p) => setEditing(p)}
          onDelete={deleteProfile}
          onNew={() => setEditing('new')}
        />

        <main className="content">
          {activeSession ? (
            <>
              <Toolbar
                session={activeSession}
                path={path}
                loading={loading}
                selectionCount={selection.size}
                showHidden={showHidden}
                query={query}
                onQueryChange={setQuery}
                shown={visible.length}
                total={afterHidden.length}
                canPreview={[...selection].some((p) => previewablePaths.includes(p))}
                onPreview={() => openPreview()}
                onNavigate={navigate}
                onUp={() => navigate(parentOf(path))}
                onRefresh={() => void refresh(activeSession.id, path)}
                onNewFolder={makeDirectory}
                onUpload={async () => uploadPaths(await api.dialog.pickFiles())}
                onDownload={() => void downloadSelected()}
                onDownloadTo={async () => {
                  const dir = await api.dialog.pickFolder()
                  if (dir) void downloadSelected(dir)
                }}
                onRename={renameSelected}
                onDelete={deleteSelected}
                onToggleHidden={() => {
                  const next = !showHidden
                  setShowHidden(next)
                  void api.settings.set({ showHidden: next })
                }}
              />

              <FileTable
                sessionId={activeSession.id}
                entries={visible}
                capabilities={activeSession.capabilities}
                sort={sort}
                onSort={(key) => setSort((current) => nextSort(current, key))}
                filterActive={query.trim() !== ''}
                loading={loading}
                selection={selection}
                onSelectionChange={setSelection}
                onOpenDir={navigate}
                onPreview={(path) => openPreview(path)}
                onDropFiles={uploadPaths}
                onDownload={(paths) => {
                  void api.xfer
                    .download(activeSession.id, paths)
                    .then(() => toast('Download queued'))
                    .catch((err: unknown) =>
                      toast(err instanceof Error ? err.message : String(err), 'error')
                    )
                }}
              />
            </>
          ) : (
            <div className="empty-state">
              <h2>No connection open</h2>
              <p>
                Pick a saved host on the left, or{' '}
                <button className="link" onClick={() => setEditing('new')}>
                  add a new one
                </button>
                .
              </p>
              <p className="hint">
                yxfer uses your SSH agent and the keys in <code>~/.ssh</code> automatically.
              </p>
            </div>
          )}
        </main>
      </div>

      <TransferPanel
        transfers={transfers}
        activeCount={activeTransfers.length}
        onCancel={(id) => void api.xfer.cancel(id)}
        onCancelAll={() => void api.xfer.cancelAll()}
        onClear={() => {
          void api.xfer.clearFinished()
          setTransfers((prev) => prev.filter((t) => t.state === 'running' || t.state === 'queued'))
        }}
        onReveal={(p) => void api.shell.reveal(p)}
      />

      {previewIndex !== null && activeSession && previewablePaths[previewIndex] && (
        <PreviewModal
          sessionId={activeSession.id}
          paths={previewablePaths}
          index={previewIndex}
          onIndexChange={setPreviewIndex}
          onClose={() => setPreviewIndex(null)}
          onDownload={(p) => {
            void api.xfer
              .download(activeSession.id, [p])
              .then(() => toast('Download queued'))
              .catch((err: unknown) =>
                toast(err instanceof Error ? err.message : String(err), 'error')
              )
          }}
        />
      )}

      {editing && (
        <ConnectionDialog
          profile={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onSave={saveProfile}
          onSaveAndConnect={async (input, secret) => {
            const saved = await saveProfile(input, secret)
            if (saved) void connect(saved)
          }}
        />
      )}

      {showSettings && (
        <SettingsDialog
          onClose={() => setShowSettings(false)}
          onConfirmDeleteChange={setConfirmDelete}
        />
      )}

      {prompt && (
        <Modal title={prompt.title} onClose={() => setPrompt(null)}>
          <PromptBody
            label={prompt.label}
            initial={prompt.initial}
            confirmLabel={prompt.confirmLabel}
            secret={/password|passphrase|secret/i.test(prompt.label)}
            onCancel={() => setPrompt(null)}
            onSubmit={(value) => {
              prompt.onSubmit(value)
              setPrompt(null)
            }}
          />
        </Modal>
      )}

      {confirm && (
        <Modal title={confirm.title} onClose={() => setConfirm(null)}>
          <p className="modal-body">{confirm.body}</p>
          <div className="modal-actions">
            <button onClick={() => setConfirm(null)}>Cancel</button>
            <button
              className={confirm.danger ? 'danger' : 'primary'}
              onClick={() => {
                confirm.onConfirm()
                setConfirm(null)
              }}
            >
              {confirm.confirmLabel}
            </button>
          </div>
        </Modal>
      )}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  )
}

function PromptBody(props: {
  label: string
  initial: string
  confirmLabel: string
  secret: boolean
  onCancel: () => void
  onSubmit: (value: string) => void
}): JSX.Element {
  const [value, setValue] = useState(props.initial)
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        props.onSubmit(value)
      }}
    >
      <label className="field">
        <span>{props.label}</span>
        <input
          autoFocus
          type={props.secret ? 'password' : 'text'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <div className="modal-actions">
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary">
          {props.confirmLabel}
        </button>
      </div>
    </form>
  )
}
