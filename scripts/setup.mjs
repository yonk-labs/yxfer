#!/usr/bin/env node
/**
 * One-command environment setup, and a doctor that reports which installer
 * targets this machine can actually produce.
 *
 *   node scripts/setup.mjs           install dependencies, then report
 *   node scripts/setup.mjs --check   report only, install nothing
 *
 * Exits non-zero only when the basics are broken (wrong Node, install
 * failure). A platform you cannot cross-build is reported, not fatal — that
 * is what the GitHub Actions workflow is for.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const checkOnly = process.argv.includes('--check')

const MIN_NODE = 20

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m'
}

const ok = (m) => console.log(`  ${c.green}✓${c.reset} ${m}`)
const warn = (m) => console.log(`  ${c.yellow}!${c.reset} ${m}`)
const bad = (m) => console.log(`  ${c.red}✗${c.reset} ${m}`)
const note = (m) => console.log(`    ${c.dim}${m}${c.reset}`)
const heading = (m) => console.log(`\n${c.bold}${m}${c.reset}`)

function has(cmd) {
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
    stdio: 'ignore'
  }).status === 0
}

let fatal = false

// ---------------------------------------------------------------- toolchain

heading('Toolchain')

const nodeMajor = Number(process.versions.node.split('.')[0])
if (nodeMajor >= MIN_NODE) {
  ok(`Node ${process.versions.node}`)
} else {
  bad(`Node ${process.versions.node} — this project needs Node ${MIN_NODE} or newer`)
  note('Install from https://nodejs.org, or use nvm: nvm install 20 && nvm use 20')
  fatal = true
}

if (has('git')) ok('git')
else warn('git not found — fine for building, needed for version control')

// ---------------------------------------------------------------- deps

heading('Dependencies')

if (checkOnly) {
  if (existsSync(join(root, 'node_modules', 'electron'))) ok('node_modules present')
  else warn('node_modules missing — run `npm run setup`')
} else {
  console.log(`  ${c.dim}running npm install…${c.reset}`)
  const install = spawnSync('npm', ['install'], { cwd: root, stdio: 'inherit', shell: true })
  if (install.status === 0) {
    ok('dependencies installed')
  } else {
    bad('npm install failed')
    fatal = true
  }
}

// ---------------------------------------------------------------- targets

heading('Installer targets from this machine')

const host = process.platform

/**
 * What each target needs on the current host.
 *
 * electron-builder downloads its own Wine and NSIS, so Windows installers
 * cross-build from macOS and Linux with no system packages at all. The one
 * genuine gap is macOS: Apple's tooling only runs on macOS.
 */
const targets = [
  {
    name: 'macOS .dmg',
    flag: 'mac',
    supported: host === 'darwin',
    reason: 'macOS installers can only be built on macOS (Apple tooling requirement).',
    fix: 'Build on a Mac, or use the GitHub Actions workflow (.github/workflows/release.yml).'
  },
  {
    name: 'Windows .exe (NSIS)',
    flag: 'win',
    supported: true,
    reason: '',
    fix: ''
  },
  {
    name: 'Linux .AppImage',
    flag: 'linux',
    supported: true,
    reason: '',
    fix: ''
  },
  {
    name: 'Linux .deb',
    flag: 'linux',
    // fpm bundles what it needs; the historic blocker was package metadata,
    // which is now set in package.json and electron-builder.yml.
    supported: true,
    reason: '',
    fix: ''
  }
]

for (const t of targets) {
  if (t.supported) ok(t.name)
  else {
    warn(`${t.name} — not available on ${host}`)
    note(t.reason)
    note(t.fix)
  }
}

if (host === 'darwin') {
  note('First Windows/Linux build downloads Wine and NSIS helpers (~30 MB, cached after).')
}

// ---------------------------------------------------------------- signing

heading('Code signing')

const macSigning = process.env.CSC_LINK || process.env.CSC_NAME
const winSigning = process.env.WIN_CSC_LINK || process.env.CSC_LINK

if (macSigning) ok('macOS signing identity configured (CSC_LINK / CSC_NAME)')
else {
  warn('macOS builds will be unsigned')
  note('Gatekeeper shows a warning on first launch; right-click → Open to bypass.')
  note('To sign: set CSC_LINK (base64 .p12) and CSC_KEY_PASSWORD, and set')
  note('mac.identity + hardenedRuntime in electron-builder.yml.')
}

if (winSigning) ok('Windows signing certificate configured')
else {
  warn('Windows builds will be unsigned')
  note('SmartScreen will warn until the .exe is signed. Set WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD.')
}

ok('Linux AppImage and deb need no signing (not signed by convention)')

// ---------------------------------------------------------------- summary

heading('Next steps')
console.log(`  ${c.cyan}npm run dev${c.reset}          run the app with live reload`)
console.log(`  ${c.cyan}npm test${c.reset}             provider test suites`)
console.log(`  ${c.cyan}npm run dist${c.reset}         installers for this OS`)
console.log(`  ${c.cyan}npm run dist:all${c.reset}     every target this machine can build`)
console.log(`  ${c.cyan}npm run doctor${c.reset}       re-run these checks`)
console.log()

if (fatal) process.exit(1)

try {
  execFileSync('node', ['--version'], { stdio: 'ignore' })
} catch {
  process.exit(1)
}
