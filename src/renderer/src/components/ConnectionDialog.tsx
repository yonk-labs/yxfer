import { useEffect, useState } from 'react'

import type { AuthMethod, Profile, ProviderKind, S3Config, SftpConfig } from '@shared/types'
import type { Identity, SshConfigHost } from '../../../preload'
import Modal from './Modal'

const api = window.yxfer

const AUTH_LABELS: Record<AuthMethod, string> = {
  auto: 'Automatic — SSH agent, then ~/.ssh keys',
  agent: 'SSH agent only',
  key: 'Specific key file',
  password: 'Password'
}

const KIND_LABELS: Record<ProviderKind, string> = {
  sftp: 'SFTP / SSH',
  s3: 'Amazon S3',
  b2: 'Backblaze B2'
}

/** Backblaze publishes one S3 endpoint per region. */
const B2_ENDPOINT_HINT = 'https://s3.us-west-004.backblazeb2.com'

export default function ConnectionDialog(props: {
  profile: Profile | null
  onCancel: () => void
  onSave: (
    input: Omit<Profile, 'id' | 'createdAt'> & { id?: string },
    secret?: string | null
  ) => Promise<Profile | null>
  onSaveAndConnect: (
    input: Omit<Profile, 'id' | 'createdAt'> & { id?: string },
    secret?: string | null
  ) => Promise<void>
}): JSX.Element {
  const [kind, setKind] = useState<ProviderKind>(props.profile?.kind ?? 'sftp')
  const [name, setName] = useState(props.profile?.name ?? '')

  const sftpExisting = props.profile?.kind === 'sftp' ? (props.profile.config as SftpConfig) : undefined
  const s3Existing =
    props.profile && props.profile.kind !== 'sftp' ? (props.profile.config as S3Config) : undefined
  const hadSecret = Boolean(sftpExisting?.hasStoredSecret ?? s3Existing?.hasStoredSecret)

  // SFTP fields
  const [host, setHost] = useState(sftpExisting?.host ?? '')
  const [port, setPort] = useState(String(sftpExisting?.port ?? 22))
  const [username, setUsername] = useState(sftpExisting?.username ?? '')
  const [auth, setAuth] = useState<AuthMethod>(sftpExisting?.auth ?? 'auto')
  const [keyPath, setKeyPath] = useState(sftpExisting?.privateKeyPath ?? '')
  const [initialPath, setInitialPath] = useState(sftpExisting?.initialPath ?? '')

  // S3 / B2 fields
  const [bucket, setBucket] = useState(s3Existing?.bucket ?? '')
  const [region, setRegion] = useState(s3Existing?.region ?? 'us-east-1')
  const [endpoint, setEndpoint] = useState(s3Existing?.endpoint ?? '')
  const [prefix, setPrefix] = useState(s3Existing?.prefix ?? '')
  const [accessKeyId, setAccessKeyId] = useState(s3Existing?.accessKeyId ?? '')

  // Shared secret field
  const [secret, setSecret] = useState('')
  const [saveSecret, setSaveSecret] = useState(hadSecret)

  const [identities, setIdentities] = useState<Identity[]>([])
  const [configHosts, setConfigHosts] = useState<SshConfigHost[]>([])
  const [hasAgent, setHasAgent] = useState(false)
  const [keychainOk, setKeychainOk] = useState(true)

  useEffect(() => {
    void (async () => {
      const [ids, hosts, agent, keychain] = await Promise.all([
        api.ssh.identities(),
        api.ssh.configHosts(),
        api.ssh.hasAgent(),
        api.profiles.secretsAvailable()
      ])
      setIdentities(ids)
      setConfigHosts(hosts)
      setHasAgent(agent)
      setKeychainOk(keychain)
      if (!keyPath && ids.length > 0) setKeyPath(ids[0].path)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const importHost = (alias: string): void => {
    const entry = configHosts.find((h) => h.alias === alias)
    if (!entry) return
    setName((current) => current || entry.alias)
    setHost(entry.hostname)
    if (entry.user) setUsername(entry.user)
    if (entry.port) setPort(String(entry.port))
    if (entry.identityFiles.length > 0) {
      setAuth('key')
      setKeyPath(entry.identityFiles[0])
    }
  }

  const isSftp = kind === 'sftp'
  const valid = isSftp ? Boolean(host.trim() && username.trim()) : Boolean(bucket.trim())

  const build = (): (Omit<Profile, 'id' | 'createdAt'> & { id?: string }) | null => {
    if (!valid) return null
    const storing = saveSecret && secret.length > 0

    if (isSftp) {
      const config: SftpConfig = {
        host: host.trim(),
        port: Number(port) || 22,
        username: username.trim(),
        auth,
        privateKeyPath: auth === 'key' ? keyPath : undefined,
        initialPath: initialPath.trim() || undefined,
        hasStoredSecret: storing || (hadSecret && saveSecret)
      }
      return {
        id: props.profile?.id,
        name: name.trim() || `${config.username}@${config.host}`,
        kind: 'sftp',
        config,
        lastPath: props.profile?.lastPath
      }
    }

    const config: S3Config = {
      bucket: bucket.trim(),
      region: region.trim() || 'us-east-1',
      endpoint: endpoint.trim() || undefined,
      prefix: prefix.trim() || undefined,
      accessKeyId: accessKeyId.trim() || undefined,
      forcePathStyle: Boolean(endpoint.trim()),
      hasStoredSecret: storing || (hadSecret && saveSecret)
    }
    return {
      id: props.profile?.id,
      name: name.trim() || config.bucket,
      kind,
      config,
      lastPath: props.profile?.lastPath
    }
  }

  /** undefined = leave any stored secret alone; null = clear it. */
  const secretForSave = (): string | null | undefined => {
    if (secret) return saveSecret ? secret : null
    if (!saveSecret && hadSecret) return null
    return undefined
  }

  const submit = async (connect: boolean): Promise<void> => {
    const input = build()
    if (!input) return
    if (connect) await props.onSaveAndConnect(input, secretForSave())
    else await props.onSave(input, secretForSave())
  }

  const secretLabel = isSftp
    ? auth === 'password'
      ? 'Password'
      : 'Key passphrase (optional)'
    : 'Secret access key'

  const showSecretField = isSftp ? auth !== 'agent' : true

  return (
    <Modal title={props.profile ? 'Edit connection' : 'New connection'} wide onClose={props.onCancel}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit(true)
        }}
      >
        <div className="field-row">
          <label className="field narrow-kind">
            <span>Type</span>
            <select
              value={kind}
              disabled={Boolean(props.profile)}
              onChange={(e) => {
                const next = e.target.value as ProviderKind
                setKind(next)
                if (next === 'b2' && !endpoint) setEndpoint(B2_ENDPOINT_HINT)
                if (next === 'b2' && region === 'us-east-1') setRegion('us-west-004')
              }}
            >
              {(Object.keys(KIND_LABELS) as ProviderKind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="field grow">
            <span>Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={isSftp ? 'Production web' : 'Backups bucket'}
            />
          </label>
        </div>

        {isSftp ? (
          <>
            {configHosts.length > 0 && !props.profile && (
              <label className="field">
                <span>Import from ~/.ssh/config</span>
                <select defaultValue="" onChange={(e) => importHost(e.target.value)}>
                  <option value="">Choose a host…</option>
                  {configHosts.map((h) => (
                    <option key={h.alias} value={h.alias}>
                      {h.alias} → {h.hostname}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <div className="field-row">
              <label className="field grow">
                <span>Host</span>
                <input
                  autoFocus
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="example.com"
                  spellCheck={false}
                />
              </label>
              <label className="field narrow">
                <span>Port</span>
                <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
              </label>
            </div>

            <div className="field-row">
              <label className="field grow">
                <span>Username</span>
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  spellCheck={false}
                />
              </label>
              <label className="field grow">
                <span>Start in (optional)</span>
                <input
                  value={initialPath}
                  onChange={(e) => setInitialPath(e.target.value)}
                  placeholder="/var/www"
                  spellCheck={false}
                />
              </label>
            </div>

            <label className="field">
              <span>Authentication</span>
              <select value={auth} onChange={(e) => setAuth(e.target.value as AuthMethod)}>
                {(Object.keys(AUTH_LABELS) as AuthMethod[]).map((m) => (
                  <option key={m} value={m}>
                    {AUTH_LABELS[m]}
                  </option>
                ))}
              </select>
            </label>

            {auth === 'auto' && (
              <p className="note">
                {hasAgent ? '✓ SSH agent detected' : '• No SSH agent running'}
                {identities.length > 0
                  ? ` · ${identities.length} key${identities.length === 1 ? '' : 's'} in ~/.ssh (${identities
                      .map((i) => i.path.split('/').pop())
                      .join(', ')})`
                  : ' · no keys found in ~/.ssh'}
              </p>
            )}

            {auth === 'agent' && (
              <p className="note">
                {hasAgent
                  ? '✓ SSH agent detected — keys loaded with ssh-add will be offered.'
                  : '⚠ No SSH agent is running. Run `ssh-add` first, or choose another method.'}
              </p>
            )}

            {auth === 'key' && (
              <>
                <div className="field-row">
                  <label className="field grow">
                    <span>Private key</span>
                    <input
                      value={keyPath}
                      onChange={(e) => setKeyPath(e.target.value)}
                      spellCheck={false}
                    />
                  </label>
                  <button
                    type="button"
                    className="align-end"
                    onClick={async () => {
                      const picked = await api.dialog.pickKey()
                      if (picked) setKeyPath(picked)
                    }}
                  >
                    Browse…
                  </button>
                </div>
                {identities.length > 0 && (
                  <div className="chips">
                    {identities.map((id) => (
                      <button
                        type="button"
                        key={id.path}
                        className={`chip ${keyPath === id.path ? 'on' : ''}`}
                        onClick={() => setKeyPath(id.path)}
                      >
                        {id.path.split('/').pop()}
                        {id.encrypted && <span className="chip-tag">passphrase</span>}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        ) : (
          <>
            <div className="field-row">
              <label className="field grow">
                <span>Bucket</span>
                <input
                  autoFocus
                  value={bucket}
                  onChange={(e) => setBucket(e.target.value)}
                  placeholder="my-backups"
                  spellCheck={false}
                />
              </label>
              <label className="field grow">
                <span>Region</span>
                <input
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                  spellCheck={false}
                />
              </label>
            </div>

            <div className="field-row">
              <label className="field grow">
                <span>Endpoint {kind === 's3' ? '(optional)' : ''}</span>
                <input
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder={kind === 'b2' ? B2_ENDPOINT_HINT : 'Leave blank for AWS'}
                  spellCheck={false}
                />
              </label>
              <label className="field grow">
                <span>Prefix (optional)</span>
                <input
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value)}
                  placeholder="team/backups"
                  spellCheck={false}
                />
              </label>
            </div>

            <label className="field">
              <span>Access key ID</span>
              <input
                value={accessKeyId}
                onChange={(e) => setAccessKeyId(e.target.value)}
                placeholder={kind === 's3' ? 'Blank to use the AWS CLI / environment' : ''}
                spellCheck={false}
              />
            </label>

            {kind === 's3' && !accessKeyId && (
              <p className="note">
                With no access key, yxfer uses the standard AWS credential chain — environment
                variables, <code>~/.aws/credentials</code>, SSO, or an instance role.
              </p>
            )}
            <p className="note">
              Folders in a bucket are key prefixes, so renaming one copies every object underneath
              it and then deletes the originals.
            </p>
          </>
        )}

        {showSecretField && (
          <>
            <label className="field">
              <span>{secretLabel}</span>
              <input
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={hadSecret ? 'Stored in keychain — type to replace' : ''}
              />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={saveSecret}
                disabled={!keychainOk}
                onChange={(e) => setSaveSecret(e.target.checked)}
              />
              Save in the system keychain
              {!keychainOk && <span className="note inline"> — unavailable on this system</span>}
            </label>
          </>
        )}

        <div className="modal-actions">
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" onClick={() => void submit(false)} disabled={!valid}>
            Save
          </button>
          <button type="submit" className="primary" disabled={!valid}>
            Save &amp; connect
          </button>
        </div>
      </form>
    </Modal>
  )
}
