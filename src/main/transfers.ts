import { randomUUID } from 'node:crypto'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { Transfer, TransferDirection } from '@shared/types'
import { rpath } from './providers/provider'
import { sessions } from './sessions'

/** Files in flight at once. SFTP servers dislike unbounded parallelism. */
const CONCURRENCY = 3

/** Finished transfers retained for the UI list. */
const HISTORY_LIMIT = 500

interface Job {
  transfer: Transfer
  controller: AbortController
  run: () => Promise<void>
}

type Emit = (t: Transfer) => void

/**
 * Queues and runs file transfers, expanding directories into per-file jobs so
 * progress stays meaningful. Provider-agnostic: it only uses the Provider
 * interface, so S3/B2 get queueing and cancellation for free.
 */
class TransferManager {
  private queue: Job[] = []
  private active = new Map<string, Job>()
  private history: Transfer[] = []
  private emit: Emit = () => {}

  setEmitter(emit: Emit): void {
    this.emit = emit
  }

  list(): Transfer[] {
    return [
      ...this.history,
      ...[...this.active.values()].map((j) => j.transfer),
      ...this.queue.map((j) => j.transfer)
    ]
  }

  /** Records a finished transfer, trimming the oldest so history stays bounded. */
  private remember(transfer: Transfer): void {
    this.history.push(transfer)
    if (this.history.length > HISTORY_LIMIT) {
      this.history.splice(0, this.history.length - HISTORY_LIMIT)
    }
  }

  clearFinished(): void {
    this.history = []
  }

  private update(t: Transfer, patch: Partial<Transfer>): void {
    Object.assign(t, patch)
    this.emit({ ...t })
  }

  private makeTransfer(
    sessionId: string,
    direction: TransferDirection,
    localPath: string,
    remotePath: string,
    total: number
  ): Transfer {
    return {
      id: randomUUID(),
      sessionId,
      direction,
      name: direction === 'upload' ? basename(localPath) : rpath.basename(remotePath),
      localPath,
      remotePath,
      state: 'queued',
      bytes: 0,
      total,
      rate: 0,
      startedAt: Date.now()
    }
  }

  /** Reports bytes/sec using a short exponential average so the UI is readable. */
  private progressFn(t: Transfer): (p: { bytes: number; total: number }) => void {
    let lastBytes = 0
    let lastAt = Date.now()
    return ({ bytes, total }) => {
      const now = Date.now()
      const dt = (now - lastAt) / 1000
      if (dt >= 0.25) {
        const instant = (bytes - lastBytes) / dt
        t.rate = t.rate === 0 ? instant : t.rate * 0.7 + instant * 0.3
        lastBytes = bytes
        lastAt = now
      }
      this.update(t, { bytes, total: total || t.total })
    }
  }

  private enqueue(job: Job): void {
    this.queue.push(job)
    this.emit({ ...job.transfer })
    this.pump()
  }

  private pump(): void {
    while (this.active.size < CONCURRENCY && this.queue.length > 0) {
      const job = this.queue.shift()!
      this.active.set(job.transfer.id, job)
      this.update(job.transfer, { state: 'running', startedAt: Date.now() })

      void job
        .run()
        .then(() => {
          this.update(job.transfer, {
            state: 'done',
            bytes: job.transfer.total || job.transfer.bytes,
            endedAt: Date.now()
          })
        })
        .catch((err: unknown) => {
          const aborted =
            job.controller.signal.aborted ||
            (err instanceof Error && err.name === 'AbortError')
          this.update(job.transfer, {
            state: aborted ? 'canceled' : 'error',
            error: aborted ? undefined : err instanceof Error ? err.message : String(err),
            endedAt: Date.now()
          })
        })
        .finally(() => {
          this.active.delete(job.transfer.id)
          this.remember({ ...job.transfer })
          this.pump()
        })
    }
  }

  cancel(id: string): void {
    const active = this.active.get(id)
    if (active) {
      active.controller.abort()
      return
    }
    const i = this.queue.findIndex((j) => j.transfer.id === id)
    if (i !== -1) {
      const [job] = this.queue.splice(i, 1)
      this.update(job.transfer, { state: 'canceled', endedAt: Date.now() })
      this.remember({ ...job.transfer })
    }
  }

  cancelAll(): void {
    for (const job of this.queue.splice(0)) {
      this.update(job.transfer, { state: 'canceled', endedAt: Date.now() })
    }
    for (const job of this.active.values()) job.controller.abort()
  }

  /** Walks a local directory into (localPath, relativePath) file pairs. */
  private async walkLocal(root: string, prefix = ''): Promise<Array<{ path: string; rel: string }>> {
    const out: Array<{ path: string; rel: string }> = []
    for (const dirent of await readdir(root, { withFileTypes: true })) {
      const full = join(root, dirent.name)
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name
      if (dirent.isDirectory()) out.push(...(await this.walkLocal(full, rel)))
      else if (dirent.isFile()) out.push({ path: full, rel })
    }
    return out
  }

  async upload(sessionId: string, localPaths: string[], remoteDir: string): Promise<string[]> {
    const provider = sessions.provider(sessionId)
    const ids: string[] = []

    for (const localPath of localPaths) {
      const info = await stat(localPath)

      if (info.isDirectory()) {
        const base = basename(localPath)
        const files = await this.walkLocal(localPath)
        // Pre-create directories so parallel file jobs never race on mkdir.
        const dirs = new Set<string>([rpath.join(remoteDir, base)])
        for (const f of files) {
          const parent = rpath.dirname(rpath.join(remoteDir, base, f.rel))
          let cursor = parent
          while (cursor.startsWith(rpath.join(remoteDir, base))) {
            dirs.add(cursor)
            cursor = rpath.dirname(cursor)
          }
        }
        for (const dir of [...dirs].sort((a, b) => a.length - b.length)) {
          await provider.mkdir(dir).catch(() => {
            // Already present, which is fine.
          })
        }
        for (const f of files) {
          ids.push(
            this.queueFile(
              sessionId,
              'upload',
              f.path,
              rpath.join(remoteDir, base, f.rel),
              (await stat(f.path)).size
            )
          )
        }
      } else {
        ids.push(
          this.queueFile(
            sessionId,
            'upload',
            localPath,
            rpath.join(remoteDir, basename(localPath)),
            info.size
          )
        )
      }
    }
    return ids
  }

  async download(sessionId: string, remotePaths: string[], localDir: string): Promise<string[]> {
    const provider = sessions.provider(sessionId)
    const ids: string[] = []

    const walkRemote = async (path: string, localBase: string): Promise<void> => {
      for (const entry of await provider.list(path)) {
        if (entry.type === 'dir') {
          await mkdir(join(localBase, entry.name), { recursive: true })
          await walkRemote(entry.path, join(localBase, entry.name))
        } else {
          ids.push(
            this.queueFile(sessionId, 'download', join(localBase, entry.name), entry.path, entry.size)
          )
        }
      }
    }

    for (const remotePath of remotePaths) {
      const entry = await provider.stat(remotePath)
      if (entry.type === 'dir') {
        const localBase = join(localDir, rpath.basename(remotePath))
        await mkdir(localBase, { recursive: true })
        await walkRemote(remotePath, localBase)
      } else {
        ids.push(
          this.queueFile(
            sessionId,
            'download',
            join(localDir, rpath.basename(remotePath)),
            remotePath,
            entry.size
          )
        )
      }
    }
    return ids
  }

  private queueFile(
    sessionId: string,
    direction: TransferDirection,
    localPath: string,
    remotePath: string,
    total: number
  ): string {
    const transfer = this.makeTransfer(sessionId, direction, localPath, remotePath, total)
    const controller = new AbortController()

    const run = async (): Promise<void> => {
      const provider = sessions.provider(sessionId)
      const opts = { onProgress: this.progressFn(transfer), signal: controller.signal }
      if (direction === 'upload') await provider.upload(localPath, remotePath, opts)
      else await provider.download(remotePath, localPath, opts)
    }

    this.enqueue({ transfer, controller, run })
    return transfer.id
  }
}

export const transfers = new TransferManager()
