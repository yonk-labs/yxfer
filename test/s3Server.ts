/**
 * Minimal in-memory S3-compatible server covering exactly the operations the
 * provider uses. Signatures are not verified — this exists to exercise the
 * real AWS SDK request/response path, not to reimplement IAM.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

interface StoredObject {
  body: Buffer
  lastModified: Date
}

export interface S3TestServer {
  port: number
  objects: Map<string, StoredObject>
  requests: string[]
  close: () => Promise<void>
}

const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const etag = (buf: Buffer): string => `"${createHash('md5').update(buf).digest('hex')}"`

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export function startS3Server(bucket: string): Promise<S3TestServer> {
  const objects = new Map<string, StoredObject>()
  const parts = new Map<string, Map<number, Buffer>>()
  const uploadKeys = new Map<string, string>()
  const requests: string[] = []

  const send = (res: ServerResponse, status: number, body = '', headers = {}): void => {
    res.writeHead(status, { 'Content-Type': 'application/xml', ...headers })
    res.end(body)
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      // Keep any trailing slash: "dir/" is a folder marker, distinct from "dir".
      const withoutLeadingSlash = url.pathname.replace(/^\//, '')
      const slash = withoutLeadingSlash.indexOf('/')
      const reqBucket = slash === -1 ? withoutLeadingSlash : withoutLeadingSlash.slice(0, slash)
      const key = slash === -1 ? '' : decodeURIComponent(withoutLeadingSlash.slice(slash + 1))
      requests.push(`${req.method} ${url.pathname}${url.search}`)

      if (reqBucket !== bucket) {
        return send(res, 404, '<Error><Code>NoSuchBucket</Code></Error>')
      }

      // HeadBucket
      if (req.method === 'HEAD' && !key) return send(res, 200)

      // ListObjectsV2
      if (req.method === 'GET' && !key && url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') ?? ''
        const delimiter = url.searchParams.get('delimiter') ?? ''
        const maxKeys = Number(url.searchParams.get('max-keys') ?? 1000)

        const matching = [...objects.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .sort(([a], [b]) => a.localeCompare(b))

        const contents: string[] = []
        const commonPrefixes = new Set<string>()

        for (const [k, obj] of matching) {
          if (delimiter) {
            const rest = k.slice(prefix.length)
            const idx = rest.indexOf(delimiter)
            if (idx !== -1) {
              commonPrefixes.add(prefix + rest.slice(0, idx + delimiter.length))
              continue
            }
          }
          if (contents.length >= maxKeys) break
          contents.push(
            `<Contents><Key>${xmlEscape(k)}</Key>` +
              `<LastModified>${obj.lastModified.toISOString()}</LastModified>` +
              `<ETag>${xmlEscape(etag(obj.body))}</ETag>` +
              `<Size>${obj.body.length}</Size>` +
              `<StorageClass>STANDARD</StorageClass></Contents>`
          )
        }

        const keyCount = contents.length + commonPrefixes.size
        return send(
          res,
          200,
          `<?xml version="1.0" encoding="UTF-8"?>` +
            `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
            `<Name>${bucket}</Name><Prefix>${xmlEscape(prefix)}</Prefix>` +
            `<KeyCount>${keyCount}</KeyCount><MaxKeys>${maxKeys}</MaxKeys>` +
            (delimiter ? `<Delimiter>${xmlEscape(delimiter)}</Delimiter>` : '') +
            `<IsTruncated>false</IsTruncated>` +
            contents.join('') +
            [...commonPrefixes]
              .sort()
              .map((p) => `<CommonPrefixes><Prefix>${xmlEscape(p)}</Prefix></CommonPrefixes>`)
              .join('') +
            `</ListBucketResult>`
        )
      }

      // DeleteObjects
      if (req.method === 'POST' && !key && url.searchParams.has('delete')) {
        const body = (await readBody(req)).toString('utf8')
        const keys = [...body.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) => m[1])
        for (const k of keys) objects.delete(k)
        return send(
          res,
          200,
          `<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
            keys.map((k) => `<Deleted><Key>${xmlEscape(k)}</Key></Deleted>`).join('') +
            `</DeleteResult>`
        )
      }

      // CreateMultipartUpload
      if (req.method === 'POST' && key && url.searchParams.has('uploads')) {
        const uploadId = randomUUID()
        parts.set(uploadId, new Map())
        uploadKeys.set(uploadId, key)
        return send(
          res,
          200,
          `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult>` +
            `<Bucket>${bucket}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${uploadId}</UploadId>` +
            `</InitiateMultipartUploadResult>`
        )
      }

      // CompleteMultipartUpload
      const completeId = url.searchParams.get('uploadId')
      if (req.method === 'POST' && key && completeId) {
        await readBody(req)
        const collected = parts.get(completeId)
        const ordered = [...(collected ?? new Map())].sort(([a], [b]) => a - b).map(([, b]) => b)
        const body = Buffer.concat(ordered)
        objects.set(key, { body, lastModified: new Date() })
        parts.delete(completeId)
        uploadKeys.delete(completeId)
        return send(
          res,
          200,
          `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult>` +
            `<Location>http://localhost/${bucket}/${xmlEscape(key)}</Location>` +
            `<Bucket>${bucket}</Bucket><Key>${xmlEscape(key)}</Key><ETag>${xmlEscape(etag(body))}</ETag>` +
            `</CompleteMultipartUploadResult>`
        )
      }

      // AbortMultipartUpload
      if (req.method === 'DELETE' && key && url.searchParams.has('uploadId')) {
        const id = url.searchParams.get('uploadId')!
        parts.delete(id)
        uploadKeys.delete(id)
        return send(res, 204)
      }

      // UploadPart
      const partNumber = url.searchParams.get('partNumber')
      if (req.method === 'PUT' && key && partNumber && url.searchParams.has('uploadId')) {
        const id = url.searchParams.get('uploadId')!
        const body = await readBody(req)
        parts.get(id)?.set(Number(partNumber), body)
        return send(res, 200, '', { ETag: etag(body) })
      }

      // CopyObject / PutObject
      if (req.method === 'PUT' && key) {
        const copySource = req.headers['x-amz-copy-source'] as string | undefined
        if (copySource) {
          const source = decodeURIComponent(copySource.replace(/^\//, '')).slice(bucket.length + 1)
          const original = objects.get(source)
          if (!original) return send(res, 404, '<Error><Code>NoSuchKey</Code></Error>')
          objects.set(key, { body: original.body, lastModified: new Date() })
          return send(
            res,
            200,
            `<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult>` +
              `<LastModified>${new Date().toISOString()}</LastModified>` +
              `<ETag>${xmlEscape(etag(original.body))}</ETag></CopyObjectResult>`
          )
        }
        const body = await readBody(req)
        objects.set(key, { body, lastModified: new Date() })
        return send(res, 200, '', { ETag: etag(body) })
      }

      // HeadObject
      if (req.method === 'HEAD' && key) {
        const obj = objects.get(key)
        if (!obj) return send(res, 404)
        res.writeHead(200, {
          'Content-Length': String(obj.body.length),
          'Last-Modified': obj.lastModified.toUTCString(),
          ETag: etag(obj.body)
        })
        return res.end()
      }

      // GetObject, with ranged reads so previews can be exercised
      if (req.method === 'GET' && key) {
        const obj = objects.get(key)
        if (!obj) return send(res, 404, '<Error><Code>NoSuchKey</Code></Error>')

        const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''))
        if (range) {
          const start = Number(range[1])
          // An open-ended or over-long range clamps to the object, as S3 does.
          const end = Math.min(range[2] === '' ? obj.body.length - 1 : Number(range[2]), obj.body.length - 1)
          if (start > end) {
            return send(res, 416, '<Error><Code>InvalidRange</Code></Error>')
          }
          const slice = obj.body.subarray(start, end + 1)
          res.writeHead(206, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(slice.length),
            'Content-Range': `bytes ${start}-${end}/${obj.body.length}`,
            'Last-Modified': obj.lastModified.toUTCString(),
            ETag: etag(obj.body)
          })
          return res.end(slice)
        }

        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(obj.body.length),
          'Last-Modified': obj.lastModified.toUTCString(),
          ETag: etag(obj.body)
        })
        return res.end(obj.body)
      }

      send(res, 400, '<Error><Code>NotImplemented</Code></Error>')
    })().catch(() => send(res, 500, '<Error><Code>InternalError</Code></Error>'))
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as { port: number }).port,
        objects,
        requests,
        close: () => new Promise<void>((done) => server.close(() => done()))
      })
    })
  })
}
