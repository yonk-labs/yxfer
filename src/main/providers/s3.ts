import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir as mkdirLocal, stat as statLocal } from 'node:fs/promises'
import { dirname as localDirname } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type _Object
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'

import type { Capabilities, RemoteEntry, S3Config } from '@shared/types'
import { countingStream } from './progress'
import { rpath, type Provider, type TransferOptions } from './provider'

export interface S3Secrets {
  secretAccessKey?: string
}

/** S3 has no directories; a zero-byte key ending in "/" stands in for one. */
const DIR_MARKER_SUFFIX = '/'

/** DeleteObjects accepts at most 1000 keys per call. */
const DELETE_BATCH = 1000

/**
 * S3-compatible object storage. Backblaze B2 and other S3-API services use
 * this same provider with a custom `endpoint`.
 *
 * Directories are synthesised from key prefixes, so `capabilities` reports
 * `realDirectories: false` — the UI uses that to soften folder semantics.
 */
export class S3Provider implements Provider {
  readonly kind: 's3' | 'b2'

  readonly capabilities: Capabilities = {
    mkdir: true,
    remove: true,
    // Implemented as server-side copy + delete, which is why it is not free.
    rename: true,
    realDirectories: false,
    symlinks: false,
    permissions: false,
    // S3 objects expose LastModified only; there is no creation or access time.
    createdTime: false,
    accessedTime: false
  }

  private client: S3Client | null = null

  constructor(
    private readonly config: S3Config,
    private readonly secrets: S3Secrets = {},
    kind: 's3' | 'b2' = 's3'
  ) {
    this.kind = kind
  }

  onClosed(): void {
    // HTTP is stateless — there is no connection to drop.
  }

  async connect(): Promise<void> {
    const { region, endpoint, accessKeyId, forcePathStyle } = this.config

    this.client = new S3Client({
      region: region || 'us-east-1',
      endpoint: endpoint || undefined,
      // Backblaze and most non-AWS endpoints require path-style addressing.
      forcePathStyle: forcePathStyle ?? Boolean(endpoint),
      // The SDK defaults to sending CRC32 checksums on every request, which
      // several S3-compatible services (Backblaze B2 among them) reject.
      // "When required" keeps checksums for the operations that mandate them.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      // Omitting `credentials` falls back to the default provider chain
      // (env vars, ~/.aws/credentials, SSO, instance roles).
      credentials:
        accessKeyId && this.secrets.secretAccessKey
          ? { accessKeyId, secretAccessKey: this.secrets.secretAccessKey }
          : undefined
    })

    // Fail fast with a clear message instead of erroring on the first listing.
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const name = err instanceof Error ? err.name : ''
      if (name === 'NotFound' || /404/.test(message)) {
        throw new Error(`Bucket "${this.config.bucket}" was not found in region ${region}.`)
      }
      if (name === 'Forbidden' || /403/.test(message)) {
        throw new Error(
          `Access denied to "${this.config.bucket}". Check the access key, secret, and bucket policy.`
        )
      }
      if (/credential/i.test(message)) {
        throw new Error(
          `No usable credentials: ${message}. Enter an access key, or configure the AWS CLI / environment.`
        )
      }
      throw new Error(`Could not reach the bucket: ${message}`)
    }
  }

  async disconnect(): Promise<void> {
    this.client?.destroy()
    this.client = null
  }

  private get s3(): S3Client {
    if (!this.client) throw new Error('Not connected')
    return this.client
  }

  private get base(): string {
    const p = (this.config.prefix ?? '').replace(/^\/+|\/+$/g, '')
    return p ? `${p}/` : ''
  }

  /** Virtual path ("/logs/app.log") to bucket key ("prefix/logs/app.log"). */
  private key(path: string): string {
    return this.base + path.replace(/^\/+/, '')
  }

  /** Bucket key back to the virtual path shown in the UI. */
  private path(key: string): string {
    return `/${key.slice(this.base.length)}`.replace(/\/+/g, '/')
  }

  async home(): Promise<string> {
    return '/'
  }

  async list(path: string): Promise<RemoteEntry[]> {
    const prefix = this.key(path === '/' ? '/' : `${path.replace(/\/+$/, '')}/`)
    const entries: RemoteEntry[] = []
    let token: string | undefined

    do {
      const page = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: prefix,
          Delimiter: '/',
          ContinuationToken: token
        })
      )

      for (const cp of page.CommonPrefixes ?? []) {
        if (!cp.Prefix) continue
        const p = this.path(cp.Prefix).replace(/\/$/, '')
        entries.push({
          name: rpath.basename(p),
          path: p,
          type: 'dir',
          size: 0,
          mtime: 0
        })
      }

      for (const obj of page.Contents ?? []) {
        if (!obj.Key) continue
        // Skip the folder marker for the directory we are listing.
        if (obj.Key === prefix) continue
        entries.push(this.toEntry(obj))
      }

      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)

    return entries
  }

  private toEntry(obj: _Object): RemoteEntry {
    const path = this.path(obj.Key!)
    return {
      name: rpath.basename(path),
      path,
      type: 'file',
      size: obj.Size ?? 0,
      mtime: obj.LastModified ? obj.LastModified.getTime() : 0
    }
  }

  async stat(path: string): Promise<RemoteEntry> {
    // The bucket root always exists, even with no keys in it.
    if (path === '/' || path === '') {
      return { name: '/', path: '/', type: 'dir', size: 0, mtime: 0 }
    }

    const key = this.key(path)

    try {
      const head = await this.s3.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key })
      )
      return {
        name: rpath.basename(path),
        path,
        type: 'file',
        size: head.ContentLength ?? 0,
        mtime: head.LastModified ? head.LastModified.getTime() : 0
      }
    } catch {
      // Not an object — it may still be a prefix with children under it.
    }

    const probe = await this.s3.send(
      new ListObjectsV2Command({
        Bucket: this.config.bucket,
        Prefix: `${key.replace(/\/+$/, '')}/`,
        MaxKeys: 1
      })
    )
    if ((probe.KeyCount ?? 0) > 0) {
      return { name: rpath.basename(path), path, type: 'dir', size: 0, mtime: 0 }
    }

    throw new Error(`No such key: ${path}`)
  }

  async mkdir(path: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: `${this.key(path).replace(/\/+$/, '')}${DIR_MARKER_SUFFIX}`,
        // An explicitly empty, known-length body; passing '' makes the SDK warn
        // about streaming a body of unknown length.
        Body: new Uint8Array(0),
        ContentLength: 0
      })
    )
  }

  /** Every key under a prefix, used for recursive delete and rename. */
  private async keysUnder(prefix: string): Promise<string[]> {
    const keys: string[] = []
    let token: string | undefined
    do {
      const page = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: prefix,
          ContinuationToken: token
        })
      )
      for (const obj of page.Contents ?? []) if (obj.Key) keys.push(obj.Key)
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
    return keys
  }

  async remove(path: string, recursive: boolean): Promise<void> {
    const key = this.key(path)
    const entry = await this.stat(path)

    if (entry.type === 'file') {
      await this.deleteKeys([key])
      return
    }

    const prefix = `${key.replace(/\/+$/, '')}/`
    const keys = await this.keysUnder(prefix)
    if (!recursive && keys.length > 1) {
      throw new Error(`"${path}" is not empty`)
    }
    await this.deleteKeys(keys)
  }

  private async deleteKeys(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
      const batch = keys.slice(i, i + DELETE_BATCH)
      const res = await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: this.config.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true }
        })
      )
      const failed = res.Errors ?? []
      if (failed.length > 0) {
        throw new Error(
          `Failed to delete ${failed.length} object(s): ${failed[0].Key} — ${failed[0].Message}`
        )
      }
    }
  }

  /**
   * S3 has no rename, so this is a server-side copy followed by a delete. On a
   * prefix it repeats per key, which costs one request per object.
   */
  async rename(from: string, to: string): Promise<void> {
    const fromKey = this.key(from)
    const entry = await this.stat(from)

    if (entry.type === 'file') {
      await this.copyKey(fromKey, this.key(to))
      await this.deleteKeys([fromKey])
      return
    }

    const fromPrefix = `${fromKey.replace(/\/+$/, '')}/`
    const toPrefix = `${this.key(to).replace(/\/+$/, '')}/`
    const keys = await this.keysUnder(fromPrefix)

    for (const key of keys) {
      await this.copyKey(key, toPrefix + key.slice(fromPrefix.length))
    }
    await this.deleteKeys(keys)
  }

  private async copyKey(from: string, to: string): Promise<void> {
    await this.s3.send(
      new CopyObjectCommand({
        Bucket: this.config.bucket,
        // CopySource must include the bucket and be URI-encoded.
        CopySource: encodeURI(`${this.config.bucket}/${from}`),
        Key: to
      })
    )
  }

  async read(remotePath: string, maxBytes: number): Promise<Buffer> {
    const res = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: this.key(remotePath),
        // Ranged GET so a preview never pulls a multi-gigabyte object.
        Range: `bytes=0-${maxBytes - 1}`
      })
    )
    if (!res.Body) return Buffer.alloc(0)

    const chunks: Buffer[] = []
    for await (const chunk of res.Body as Readable) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks)
  }

  async download(remotePath: string, localPath: string, opts: TransferOptions = {}): Promise<void> {
    const res = await this.s3.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: this.key(remotePath) }),
      { abortSignal: opts.signal }
    )
    if (!res.Body) throw new Error(`Empty response body for ${remotePath}`)

    await mkdirLocal(localDirname(localPath), { recursive: true })
    const total = res.ContentLength ?? 0

    await pipeline(res.Body as Readable, countingStream(total, opts), createWriteStream(localPath), {
      signal: opts.signal
    })
  }

  async upload(localPath: string, remotePath: string, opts: TransferOptions = {}): Promise<void> {
    const { size } = await statLocal(localPath)

    // lib-storage switches to multipart above the part size, so large objects
    // stream rather than buffering in memory.
    const upload = new Upload({
      client: this.s3,
      params: {
        Bucket: this.config.bucket,
        Key: this.key(remotePath),
        Body: createReadStream(localPath),
        ContentLength: size > 0 ? size : undefined
      },
      queueSize: 4,
      partSize: 8 * 1024 * 1024,
      leavePartsOnError: false
    })

    upload.on('httpUploadProgress', (p) => {
      opts.onProgress?.({ bytes: p.loaded ?? 0, total: p.total ?? size })
    })

    if (opts.signal) {
      if (opts.signal.aborted) throw abortError()
      opts.signal.addEventListener('abort', () => void upload.abort(), { once: true })
    }

    try {
      await upload.done()
    } catch (err) {
      // An aborted multipart upload surfaces as a generic error; normalise it
      // so the transfer manager reports "canceled" rather than "failed".
      if (opts.signal?.aborted) throw abortError()
      throw err
    }
    opts.onProgress?.({ bytes: size, total: size })
  }
}

function abortError(): Error {
  const err = new Error('Transfer canceled')
  err.name = 'AbortError'
  return err
}
