#!/usr/bin/env node
/**
 * Builds installers for one or more platforms and prints what landed.
 *
 *   node scripts/build-installers.mjs              this OS only
 *   node scripts/build-installers.mjs mac win      named platforms
 *   node scripts/build-installers.mjs all          everything this host can do
 *
 * Compiles the app once, then runs electron-builder per platform. A platform
 * that fails does not abort the others — the summary reports each outcome, so
 * one broken target still leaves you with the installers that did build.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const releaseDir = join(root, 'release')

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m'
}

const HOST_PLATFORM = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform]

/**
 * macOS is the only target with a hard host requirement.
 *
 * Windows is packaged one architecture at a time: asking NSIS for both in a
 * single run also emits a combined dual-arch installer twice the size, which
 * is just a redundant download next to the per-arch ones.
 */
const PLATFORMS = {
  mac: { flag: '--mac', label: 'macOS (.dmg)', hostOnly: 'darwin', archs: [null] },
  win: { flag: '--win', label: 'Windows (.exe)', hostOnly: null, archs: ['--x64', '--arm64'] },
  linux: { flag: '--linux', label: 'Linux (.AppImage, .deb)', hostOnly: null, archs: [null] }
}

const args = process.argv.slice(2).filter((a) => !a.startsWith('-'))
let requested

if (args.length === 0) {
  requested = [HOST_PLATFORM]
} else if (args.includes('all')) {
  requested = Object.keys(PLATFORMS)
} else {
  requested = args
}

const unknown = requested.filter((p) => !PLATFORMS[p])
if (unknown.length > 0) {
  console.error(
    `Unknown platform(s): ${unknown.join(', ')}\nUse: mac, win, linux, or all.`
  )
  process.exit(2)
}

/** Files already in release/ so the summary shows only what this run made. */
const before = new Set(safeList(releaseDir))

console.log(`\n${c.bold}Compiling${c.reset}`)
const compile = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: true })
if (compile.status !== 0) {
  console.error(`\n${c.red}Build failed — no installers produced.${c.reset}`)
  process.exit(1)
}

const results = []

for (const platform of requested) {
  const { flag, label, hostOnly, archs } = PLATFORMS[platform]

  if (hostOnly && process.platform !== hostOnly) {
    results.push({ platform, label, status: 'skipped', detail: `needs to run on ${hostOnly}` })
    console.log(`\n${c.yellow}Skipping ${label}${c.reset} — must be built on ${hostOnly}.`)
    continue
  }

  let failed = null

  for (const arch of archs) {
    const suffix = arch ? ` ${arch.replace('--', '')}` : ''
    console.log(`\n${c.bold}Packaging ${label}${suffix}${c.reset}`)

    // Target selection lives in electron-builder.yml; these flags pick OS/arch.
    const argv = ['electron-builder', flag, ...(arch ? [arch] : [])]
    const run = spawnSync('npx', argv, { cwd: root, stdio: 'inherit', shell: true })

    if (run.status !== 0) {
      failed = `electron-builder exited ${run.status}${suffix ? ` on${suffix}` : ''}`
      // Keep going: the other architecture may still build.
    }
  }

  results.push({
    platform,
    label,
    status: failed ? 'failed' : 'ok',
    detail: failed ?? ''
  })
}

// ------------------------------------------------------------------ summary

const produced = safeList(releaseDir)
  .filter((f) => !before.has(f))
  .filter((f) => /\.(dmg|exe|AppImage|deb|rpm|zip)$/.test(f))
  .sort()

console.log(`\n${c.bold}Summary${c.reset}`)
for (const r of results) {
  const mark =
    r.status === 'ok'
      ? `${c.green}✓${c.reset}`
      : r.status === 'skipped'
        ? `${c.yellow}–${c.reset}`
        : `${c.red}✗${c.reset}`
  console.log(`  ${mark} ${r.label}${r.detail ? ` ${c.dim}(${r.detail})${c.reset}` : ''}`)
}

if (produced.length > 0) {
  console.log(`\n${c.bold}Installers${c.reset} ${c.dim}(release/)${c.reset}`)
  for (const file of produced) {
    const size = statSync(join(releaseDir, file)).size
    console.log(`  ${file}  ${c.dim}${(size / 1024 / 1024).toFixed(0)} MB${c.reset}`)
  }
} else {
  console.log(`\n${c.yellow}No new installer files in release/.${c.reset}`)
}

const skippedMac = results.some((r) => r.platform === 'mac' && r.status === 'skipped')
if (skippedMac) {
  console.log(
    `\n${c.dim}To build macOS installers off a Mac, push a tag and let` +
      ` .github/workflows/release.yml do it.${c.reset}`
  )
}

console.log()
process.exit(results.some((r) => r.status === 'failed') ? 1 : 0)

function safeList(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
