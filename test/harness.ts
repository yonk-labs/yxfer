/**
 * Shared helpers for the provider suites.
 *
 * These tests run inside Electron (see scripts/test.mjs) because the main
 * process depends on `app` and `safeStorage`. Each suite drives a real
 * provider against a local fake server, so the transport, streaming and
 * cancellation paths are all genuinely exercised.
 */

export class Suite {
  failures = 0
  private readonly name: string

  constructor(name: string) {
    this.name = name
    console.log(`\n=== ${name} ===`)
  }

  section(title: string): void {
    console.log(`\n${title}`)
  }

  check(label: string, ok: boolean, detail = ''): void {
    if (ok) {
      console.log(`  ✓ ${label}`)
    } else {
      this.failures++
      console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
    }
  }

  info(message: string): void {
    console.log(`    ${message}`)
  }

  done(): number {
    console.log(
      this.failures === 0
        ? `\n${this.name}: all checks passed`
        : `\n${this.name}: ${this.failures} check(s) FAILED`
    )
    return this.failures
  }
}

/** Polls until the predicate holds or the timeout elapses. */
export async function waitFor(predicate: () => boolean, ms = 20000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}
