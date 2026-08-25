import { Transform } from 'node:stream'

import type { TransferOptions } from './provider'

/**
 * Passthrough that reports byte counts without buffering. Events are throttled
 * to roughly 20/sec so the UI stays responsive on fast links; the final chunk
 * always reports so progress ends exactly at 100%.
 */
export function countingStream(total: number, opts: TransferOptions): Transform {
  let bytes = 0
  let lastTick = 0
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length
      const now = Date.now()
      if (opts.onProgress && (now - lastTick > 50 || bytes === total)) {
        lastTick = now
        opts.onProgress({ bytes, total })
      }
      cb(null, chunk)
    },
    flush(cb) {
      opts.onProgress?.({ bytes, total })
      cb()
    }
  })
}
