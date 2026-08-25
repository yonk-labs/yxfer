# yxfer

A small desktop app for drag-and-drop file transfer to remote storage. Browse a
remote host, drag files in from Finder to upload, drag them out to download.

Supported backends:

| Backend | Status |
| --- | --- |
| SFTP over SSH | ✅ |
| Amazon S3 | ✅ |
| Backblaze B2 | ✅ (S3-compatible endpoint) |

## Setup

```sh
npm run setup    # installs dependencies, then reports what this machine can build
npm run dev      # live-reload development
npm test         # provider test suites
npm run doctor   # re-run the environment checks without installing
```

## Building installers

```sh
npm run dist        # installers for the OS you are on
npm run dist:win    # Windows .exe
npm run dist:linux  # Linux .AppImage and .deb
npm run dist:mac    # macOS .dmg (x64 + arm64)
npm run dist:all    # everything this host can produce
```

Everything lands in `release/`. `dist:all` compiles once, then packages each
platform in turn; a platform that fails does not abort the rest, and the run
ends with a summary of what was produced.

### What cross-builds, and what doesn't

| Building on | macOS `.dmg` | Windows `.exe` | Linux `.AppImage` / `.deb` |
| --- | --- | --- | --- |
| macOS | ✅ | ✅ | ✅ |
| Linux | ❌ | ✅ | ✅ |
| Windows | ❌ | ✅ | ⚠️ use WSL |

Windows and Linux installers cross-build with no system packages — electron-builder
downloads its own Wine and NSIS on first use (~30 MB, then cached). **macOS is the
exception**: Apple's tooling only runs on macOS, so a `.dmg` needs a Mac.

For all three from anywhere, push a tag and let CI do it:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

`.github/workflows/release.yml` builds each platform on its native runner,
runs the tests first, uploads the installers as artifacts, and attaches them
to a GitHub Release. It also runs on demand from the Actions tab.

### Signing

Builds are unsigned by default and will still install — macOS Gatekeeper warns
on first launch (right-click → Open), and Windows SmartScreen warns until the
`.exe` is signed.

To sign, set these before building (or as repository secrets for CI):

| Variable | Purpose |
| --- | --- |
| `CSC_LINK` / `CSC_KEY_PASSWORD` | macOS Developer ID `.p12`, base64-encoded |
| `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` | Windows code-signing certificate |

For macOS you also need to set `mac.identity` and turn on `hardenedRuntime` in
`electron-builder.yml`, then notarize. Linux packages are unsigned by convention.

## How it works

```
src/
  main/                 Node side — all network and disk access lives here
    providers/
      provider.ts       the Provider interface every backend implements
      sftp.ts           SFTP over SSH (ssh2)
      s3.ts             S3 and any S3-compatible service, including B2
      progress.ts       shared byte-counting stream
    sessions.ts         live connections; the one place that knows about kinds
    transfers.ts        queue, concurrency, progress, cancellation
    store.ts            saved profiles + secrets (OS keychain via safeStorage)
    hostkeys.ts         trust-on-first-use SSH host key pinning
    sshIdentities.ts    ~/.ssh key discovery and ~/.ssh/config parsing
    ipc.ts              the renderer-facing API surface
  preload/              contextBridge; the renderer has no Node access
  renderer/             React UI
  shared/types.ts       types used on both sides
```

The renderer never speaks to a backend directly. It works in terms of
absolute POSIX paths and a `capabilities` record, so the same file browser
drives SFTP and object storage without special-casing.

## Browsing

Click any column header to sort; click it again to reverse. Folders stay
grouped above files whichever column is active.

The **Filter** box narrows the current directory — `⌘F` / `Ctrl+F` jumps to it,
`Esc` clears it — and shows an *n of m* count while applied. It matches names
**and dates**, so all of these work:

| Type | Matches |
| --- | --- |
| `report` | names containing "report" |
| `2026-03` | anything dated March 2026 |
| `2026-03-02` | that exact day |
| `march` | the same, by month name |
| `2026` | the whole year |

### Which dates exist

Columns appear only when the backend can actually fill them, so you never see
a column of dashes:

| Column | SFTP | S3 / B2 |
| --- | --- | --- |
| Modified | ✅ | ✅ |
| Accessed | ✅ | — |
| Created | — | — |

**Creation time is not available from either backend.** SFTP v3 — the version
`ssh2` speaks, and what almost every server offers — carries only `atime` and
`mtime` in its file attributes; there is no birth time in the protocol. S3
objects expose `LastModified` and nothing else. Rather than show an always-empty
column, the Created column is gated on a `createdTime` capability that both
providers report as `false`. The field, the sort and the date search are all
wired up, so a future backend that does report creation time (SFTP v4, a local
filesystem provider) lights the column up with no UI changes.

Accessed (`atime`) *is* real SFTP data and is shown in its place.

## Preview

Double-click a file, press `Space`, or hit **Preview** to open it without
downloading. `←` / `→` step through the other files in the listing and `Esc`
closes.

| Type | Shown as |
| --- | --- |
| `png` `jpg` `gif` `webp` `bmp` `ico` `avif` `svg` | the image, on a checkerboard so transparency reads |
| Known text extensions, dotfiles, `Makefile`/`README`-style names | monospaced text |
| Anything else | sniffed — no NUL bytes and valid UTF-8 means text |
| Genuinely binary | a note explaining why, with **View as text** and **Download** |

**View as text** in the header forces a text rendering of *anything*, images
and binaries included; control characters are shown as `·` so the output stays
readable. The setting sticks as you step between files.

Previews are capped and read only the head of a file — 24 MB for images, 1 MB
for text, fetched with a ranged read (an SFTP partial stream or an S3 ranged
`GetObject`). Previewing a 40 GB archive costs one megabyte, and long text is
marked as truncated rather than loaded whole.

### Adding a backend

1. Implement `Provider` in `src/main/providers/`.
2. Add a case to `SessionManager.build` in `src/main/sessions.ts`.
3. Add its fields to `ConnectionDialog.tsx`.
4. Copy a suite in `test/` and point it at a local fake.

Report honest `capabilities` — the UI disables actions a backend cannot
perform rather than failing at request time.

## SSH authentication

The default auth mode is **Automatic**, which tries, in order:

1. the running SSH agent (`SSH_AUTH_SOCK`), then
2. every private key found in `~/.ssh`, in OpenSSH's own preference order
   (`id_ed25519`, `id_ecdsa`, `id_rsa`, …).

Encrypted keys are skipped unless a passphrase is stored, since the agent
usually holds them already. You can also pin a specific key file, use the
agent only, or use a password. Saved hosts can be pre-filled from
`~/.ssh/config`.

Host keys are pinned on first connect and stored in
`known-hosts.json` under the app's user-data directory. A changed key aborts
the connection with both fingerprints shown; clear the entry in
**Settings → Known hosts** to accept a new one. This is deliberately separate
from `~/.ssh/known_hosts`, which yxfer does not read or write.

## S3 and Backblaze B2

Buckets have no real directories, so folders are key prefixes:

- **New folder** writes a zero-byte `name/` marker.
- **Rename** on a folder is a server-side copy of every object underneath it
  followed by a delete — proportional to object count, not free.
- The **Mode** column is hidden, because objects have no POSIX permissions.

Set an **Endpoint** for any S3-compatible service; that also switches on
path-style addressing. For B2 the endpoint looks like
`https://s3.us-west-004.backblazeb2.com`. Leaving the access key blank on an
Amazon S3 profile falls back to the standard AWS credential chain (environment
variables, `~/.aws/credentials`, SSO, instance roles).

Requests use `requestChecksumCalculation: 'WHEN_REQUIRED'`. The AWS SDK
otherwise attaches CRC32 checksums to every request, which several
S3-compatible services reject.

## Secrets

Passwords, key passphrases and secret access keys are encrypted with
Electron's `safeStorage` (Keychain on macOS, DPAPI on Windows, libsecret on
Linux). If the OS keyring is unavailable, yxfer refuses to store the secret
rather than writing it in plaintext, and asks for it per connection instead.

## Known limits

- **Drag-out is size-limited.** Dropping a remote file onto Finder needs the
  file to exist locally before the drag gesture ends, and Electron exposes no
  promised-file API. yxfer fetches to a temp directory and takes over the drag
  if that finishes within 2 seconds; anything slower completes as a normal
  download to the download folder, and the app says so. Drag-*in* has no such
  limit.
- **No transfer resume.** A canceled or failed transfer restarts from zero.
- **SFTP uses a single stream per file**, three files at a time. That is
  slower than parallel-chunk transfer on high-latency links.
- `~/.ssh/config` parsing covers `Host`, `HostName`, `User`, `Port`,
  `IdentityFile` and `Host *` defaults. `Include`, `Match` and token
  expansion (`%h`, `%p`) are ignored.
- Unsigned builds. macOS will warn on first launch until the app is signed and
  notarized.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
