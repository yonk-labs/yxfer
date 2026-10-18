# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm run setup      # install deps, then report which installer targets this machine can build
npm run doctor     # the same environment report, installs nothing
npm run dev        # electron-vite dev with HMR
npm run typecheck  # tsc --noEmit over both project configs — this is the lint step
npm run build      # typecheck + electron-vite build into out/
npm test           # provider suites
npm run dist       # installers for the host OS; :mac/:win/:linux/:all also exist
```

There is no ESLint/Prettier setup — `npm run typecheck` is the only static check, and it
runs `tsconfig.node.json` (main + preload + shared + test) and `tsconfig.web.json`
(renderer + shared + preload) separately. Both are `strict` with `noUnusedLocals`.

### Tests

`npm test` (`scripts/test.mjs`) esbuild-bundles `test/index.ts` to CJS and runs it **inside
Electron**, because the code under test depends on `app` and `safeStorage`. Plain `node`
cannot run these suites, and there is no test-name filter. Granularity is the suite:
to run just one, comment out the other `runXSuite()` call in `test/index.ts`.

Each suite drives a real provider against a local fake — an in-process `ssh2` SFTP server
(`test/testServer.ts`) and an in-memory S3-compatible HTTP server (`test/s3Server.ts`) —
so transport, streaming, progress and cancellation are genuinely exercised. Suites call
`app.setPath('userData', …)` to redirect `profiles.json` / `known-hosts.json` into a temp
dir; keep that in any new suite or you will clobber real user data.

On Linux (including CI) the suites need a display: `xvfb-run --auto-servernum npm test`.

## Architecture

Electron three-process split. **All network and disk access lives in `src/main/`**; the
renderer has no Node access and reaches main only through the `contextBridge` API in
`src/preload/index.ts`, exposed as `window.yxfer`.

- `src/main/providers/provider.ts` — the `Provider` interface every backend implements,
  plus `rpath` POSIX path helpers.
- `src/main/sessions.ts` — live connections. `SessionManager.build` is the single
  `switch` on provider kind.
- `src/main/transfers.ts` — queue, concurrency (3 files in flight), smoothed progress,
  cancellation. Provider-agnostic: it only touches the `Provider` interface, so a new
  backend inherits queueing and cancellation for free.
- `src/main/ipc.ts` — the entire renderer-facing surface, one `handle()` per channel.
- `src/main/store.ts` / `hostkeys.ts` — JSON under `app.getPath('userData')`, mode 0600.
- `src/shared/types.ts` — types used on both sides; must import from neither side.

### Invariants worth preserving

**Remote paths are always absolute POSIX strings.** Use `rpath.join/dirname/basename`
from `providers/provider.ts` — never `node:path` — for anything on the remote side.

**Capabilities gate the UI, not runtime errors.** Each provider declares a `Capabilities`
record (`realDirectories`, `permissions`, `createdTime`, `accessedTime`, …); the renderer
hides columns and disables actions from it rather than letting a request fail. This is why
the same file browser drives SFTP and object storage with no special-casing, and why
`createdTime: false` on both providers hides the Created column while the field, sort and
date-search stay wired up for a future backend that does report one.

**Every IPC handler returns an envelope.** `handle()` in `ipc.ts` wraps results as
`{ok: true, value}` / `{ok: false, error}`; `invoke()` in the preload unwraps it and
rethrows. Errors reach the renderer as plain messages, never as objects.

**Secrets are never written in plaintext.** `store.setSecret` throws if
`safeStorage.isEncryptionAvailable()` is false rather than falling back to a clear-text
file; the UI then asks per connection.

**Path aliases:** `@shared/*` everywhere, `@/*` for `src/renderer/src/*` in the renderer
only. Declared in three places that must stay in sync — `electron.vite.config.ts`,
both tsconfigs, and the esbuild `alias` in `scripts/test.mjs`.

### Adding a backend

1. Implement `Provider` in `src/main/providers/`.
2. Add a case to `SessionManager.build` in `src/main/sessions.ts`.
3. Add its fields to `ConnectionDialog.tsx`.
4. Copy a suite in `test/` and point it at a local fake.

Report honest capabilities — the UI disables what a backend cannot do.

## Deliberate constraints

These look like bugs but are decisions; read the surrounding comment before changing them.

- **CSP is applied at build time only** (`cspPlugin` in `electron.vite.config.ts`). The
  shipped policy forbids the inline scripts and websocket Vite needs for HMR, so applying
  it in dev leaves a blank window.
- **Drag-out has a 2-second budget** (`DRAG_BUDGET_MS` in `ipc.ts`). Electron exposes no
  promised-file API, so a remote file must exist locally before the drag gesture ends;
  anything slower falls back to a normal download plus a notice.
- **S3 uses `requestChecksumCalculation: 'WHEN_REQUIRED'`.** The AWS SDK default attaches
  CRC32 to every request, which B2 and several other S3-compatible services reject.
- **SFTP host keys are pinned TOFU into `known-hosts.json`** under userData, deliberately
  separate from `~/.ssh/known_hosts`, which yxfer never reads or writes.
- **`electron-builder.yml` lists no `arch` under `win`.** `scripts/build-installers.mjs`
  passes one arch per invocation; listing both makes NSIS additionally emit a dual-arch
  installer of twice the size, and a CLI `--x64` does not override it.
- **`preview.read` is capped** (24 MB images, 1 MB text, ranged reads). Never use
  `Provider.read` to fetch a whole file.

## Releases

`.github/workflows/release.yml` builds each platform on its native runner on a `v*` tag
push (or manual dispatch), runs the tests first, and attaches installers to a GitHub
Release. macOS `.dmg` requires a macOS host; Windows and Linux cross-build from anywhere.
Builds are unsigned unless the `MAC_CERT_P12_BASE64` / `MAC_CERT_PASSWORD` and
`WIN_CERT_P12_BASE64` / `WIN_CERT_PASSWORD` repository secrets are populated (the workflow
maps them to electron-builder's `CSC_LINK` / `WIN_CSC_LINK` env vars).
