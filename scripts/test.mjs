/**
 * Bundles the test suites and runs them inside Electron.
 *
 * The suites exercise main-process code that depends on Electron's `app` and
 * `safeStorage`, so plain `node` cannot run them.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'
import { build } from 'esbuild'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'out', 'test')
const outFile = join(outDir, 'index.cjs')

mkdirSync(outDir, { recursive: true })

await build({
  entryPoints: [join(root, 'test', 'index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: outFile,
  // Electron and the native-ish SDKs stay external and resolve from node_modules.
  external: ['electron', 'ssh2', '@aws-sdk/*'],
  alias: { '@shared': join(root, 'src', 'shared') },
  logLevel: 'warning'
})

const child = spawn(electron, [outFile], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', NODE_NO_WARNINGS: '1' }
})

child.on('exit', (code) => {
  rmSync(outDir, { recursive: true, force: true })
  process.exit(code ?? 1)
})
