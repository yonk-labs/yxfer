/**
 * Minimal in-process SFTP server for testing the provider.
 * Serves a real directory over a loopback port; accepts any public key.
 */
import { constants } from 'node:fs'
import {
  close as fsClose,
  fstat as fsFstat,
  mkdir as fsMkdir,
  open as fsOpen,
  read as fsRead,
  readdir as fsReaddir,
  rename as fsRename,
  rmdir as fsRmdir,
  stat as fsStat,
  unlink as fsUnlink,
  write as fsWrite
} from 'node:fs'
import { join, normalize, resolve as resolvePath } from 'node:path'
import { Server, utils } from 'ssh2'

const { OPEN_MODE, STATUS_CODE } = utils.sftp

export interface TestServer {
  port: number
  close: () => Promise<void>
}

export function startServer(root: string): Promise<TestServer> {
  const hostKey = utils.generateKeyPairSync('ed25519').private

  /** Maps a client-visible path onto the sandbox root. */
  const real = (p: string): string => {
    const rel = normalize(p).replace(/^\/+/, '')
    const full = resolvePath(join(root, rel))
    if (!full.startsWith(resolvePath(root))) throw new Error('escape')
    return full
  }
  const virt = (full: string): string => {
    const rel = full.slice(resolvePath(root).length)
    return rel === '' ? '/' : rel.replace(/\\/g, '/')
  }

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'publickey') ctx.accept()
      else if (ctx.method === 'password') ctx.accept()
      else ctx.reject(['publickey', 'password'])
    })

    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp()
          const handles = new Map<number, { fd?: number; dir?: string; read?: boolean }>()
          let nextHandle = 0
          const makeHandle = (data: { fd?: number; dir?: string }): Buffer => {
            const id = nextHandle++
            handles.set(id, data)
            const buf = Buffer.alloc(4)
            buf.writeUInt32BE(id, 0)
            return buf
          }
          const getHandle = (h: Buffer): { fd?: number; dir?: string; read?: boolean } | undefined =>
            handles.get(h.readUInt32BE(0))

          sftp.on('REALPATH', (reqid, p) => {
            try {
              const target = p === '.' || p === '' ? '/' : virt(real(p))
              sftp.name(reqid, [{ filename: target, longname: target, attrs: {} as never }])
            } catch {
              sftp.status(reqid, STATUS_CODE.FAILURE)
            }
          })

          sftp.on('OPENDIR', (reqid, p) => {
            try {
              const full = real(p)
              fsStat(full, (err, st) => {
                if (err || !st.isDirectory()) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
                sftp.handle(reqid, makeHandle({ dir: full }))
              })
            } catch {
              sftp.status(reqid, STATUS_CODE.FAILURE)
            }
          })

          sftp.on('READDIR', (reqid, h) => {
            const entry = getHandle(h)
            if (!entry?.dir) return sftp.status(reqid, STATUS_CODE.FAILURE)
            if (entry.read) return sftp.status(reqid, STATUS_CODE.EOF)
            entry.read = true
            fsReaddir(entry.dir, { withFileTypes: true }, (err, items) => {
              if (err) return sftp.status(reqid, STATUS_CODE.FAILURE)
              const names = items.map((i) => {
                const st = require('node:fs').statSync(join(entry.dir!, i.name))
                const kind = i.isDirectory() ? 'd' : '-'
                return {
                  filename: i.name,
                  longname: `${kind}rw-r--r-- 1 test test ${st.size} Jan 1 00:00 ${i.name}`,
                  attrs: {
                    mode: st.mode,
                    uid: st.uid,
                    gid: st.gid,
                    size: st.size,
                    atime: Math.floor(st.atimeMs / 1000),
                    mtime: Math.floor(st.mtimeMs / 1000)
                  }
                }
              })
              sftp.name(reqid, names as never)
            })
          })

          const doStat = (reqid: number, p: string): void => {
            try {
              fsStat(real(p), (err, st) => {
                if (err) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
                sftp.attrs(reqid, {
                  mode: st.mode,
                  uid: st.uid,
                  gid: st.gid,
                  size: st.size,
                  atime: Math.floor(st.atimeMs / 1000),
                  mtime: Math.floor(st.mtimeMs / 1000)
                } as never)
              })
            } catch {
              sftp.status(reqid, STATUS_CODE.FAILURE)
            }
          }
          sftp.on('STAT', doStat)
          sftp.on('LSTAT', doStat)

          sftp.on('FSTAT', (reqid, h) => {
            const entry = getHandle(h)
            if (entry?.fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE)
            fsFstat(entry.fd, (err, st) => {
              if (err) return sftp.status(reqid, STATUS_CODE.FAILURE)
              sftp.attrs(reqid, { mode: st.mode, size: st.size } as never)
            })
          })

          sftp.on('OPEN', (reqid, filename, flags) => {
            try {
              const full = real(filename)
              let mode = constants.O_RDONLY
              if (flags & OPEN_MODE.WRITE) mode = constants.O_WRONLY | constants.O_CREAT
              if (flags & OPEN_MODE.TRUNC) mode |= constants.O_TRUNC
              if (flags & OPEN_MODE.APPEND) mode |= constants.O_APPEND
              fsOpen(full, mode, 0o644, (err, fd) => {
                if (err) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
                sftp.handle(reqid, makeHandle({ fd }))
              })
            } catch {
              sftp.status(reqid, STATUS_CODE.FAILURE)
            }
          })

          sftp.on('READ', (reqid, h, offset, length) => {
            const entry = getHandle(h)
            if (entry?.fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE)
            const buf = Buffer.alloc(length)
            fsRead(entry.fd, buf, 0, length, offset, (err, read) => {
              if (err) return sftp.status(reqid, STATUS_CODE.FAILURE)
              if (read === 0) return sftp.status(reqid, STATUS_CODE.EOF)
              sftp.data(reqid, buf.subarray(0, read))
            })
          })

          sftp.on('WRITE', (reqid, h, offset, data) => {
            const entry = getHandle(h)
            if (entry?.fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE)
            fsWrite(entry.fd, data, 0, data.length, offset, (err) => {
              sftp.status(reqid, err ? STATUS_CODE.FAILURE : STATUS_CODE.OK)
            })
          })

          sftp.on('CLOSE', (reqid, h) => {
            const key = h.readUInt32BE(0)
            const entry = handles.get(key)
            handles.delete(key)
            if (entry?.fd !== undefined) {
              fsClose(entry.fd, () => sftp.status(reqid, STATUS_CODE.OK))
            } else {
              sftp.status(reqid, STATUS_CODE.OK)
            }
          })

          sftp.on('MKDIR', (reqid, p) => {
            fsMkdir(real(p), (err) => sftp.status(reqid, err ? STATUS_CODE.FAILURE : STATUS_CODE.OK))
          })
          sftp.on('RMDIR', (reqid, p) => {
            fsRmdir(real(p), (err) => sftp.status(reqid, err ? STATUS_CODE.FAILURE : STATUS_CODE.OK))
          })
          sftp.on('REMOVE', (reqid, p) => {
            fsUnlink(real(p), (err) => sftp.status(reqid, err ? STATUS_CODE.FAILURE : STATUS_CODE.OK))
          })
          sftp.on('RENAME', (reqid, from, to) => {
            fsRename(real(from), real(to), (err) =>
              sftp.status(reqid, err ? STATUS_CODE.FAILURE : STATUS_CODE.OK)
            )
          })
        })
      })
    })

    client.on('error', () => {
      /* client disconnects are expected during teardown */
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as { port: number }).port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done())
          })
      })
    })
  })
}
