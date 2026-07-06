import { generateKeyPairSync } from 'crypto'
import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  writeSync,
  readdirSync,
  statSync,
  lstatSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  rmdirSync
} from 'fs'
import type { Stats } from 'fs'
import { normalize } from 'path'
import type { AddressInfo } from 'net'
import { Server, utils } from 'ssh2'

const { STATUS_CODE, OPEN_MODE } = utils.sftp

function attrsFromStats(st: Stats) {
  return {
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000)
  }
}
function attrsOf(p: string) {
  return attrsFromStats(statSync(p))
}

/**
 * Minimal fs-backed SFTP server (server-mode protocol) sufficient to exercise
 * the client SFTP service + transfer engine: REALPATH/OPENDIR/READDIR/STAT/
 * LSTAT/MKDIR/RENAME/REMOVE/RMDIR/OPEN/READ/WRITE/CLOSE. Also answers `uname`
 * over exec so connect()'s OS-detection succeeds. Backed by a real temp dir.
 */
export function startSftpServer(root: string): Promise<{ port: number; close: () => void }> {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' }
  })

  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (ctx) => ctx.accept())
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession()

        session.on('exec', (accept, _reject, info) => {
          const stream = accept()
          if (info.command.startsWith('uname')) stream.write('Linux sftphost 5.15 x86_64\n')
          else if (info.command.startsWith('hostname')) stream.write('sftphost\n')
          stream.exit(0)
          stream.end()
        })

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        session.on('sftp', (accept: any) => {
          const sftp = accept()
          let handleSeq = 0
          const dirHandles = new Map<number, { path: string; done: boolean }>()
          const fileHandles = new Map<number, number>() // handle -> fd
          const mkHandle = () => {
            const id = handleSeq++
            return {
              id,
              buf: Buffer.from([id & 0xff, (id >> 8) & 0xff, (id >> 16) & 0xff, (id >> 24) & 0xff])
            }
          }
          const idOf = (h: Buffer) => h.readUInt32LE(0)

          sftp.on('REALPATH', (reqid: number, p: string) => {
            const resolved = !p || p === '.' ? root : normalize(p)
            sftp.name(reqid, [{ filename: resolved, longname: resolved, attrs: attrsOf(resolved) }])
          })
          sftp.on('OPENDIR', (reqid: number, p: string) => {
            try {
              statSync(p)
              const h = mkHandle()
              dirHandles.set(h.id, { path: p, done: false })
              sftp.handle(reqid, h.buf)
            } catch {
              sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
            }
          })
          sftp.on('READDIR', (reqid: number, h: Buffer) => {
            const state = dirHandles.get(idOf(h))
            if (!state || state.done) return sftp.status(reqid, STATUS_CODE.EOF)
            state.done = true
            const names = readdirSync(state.path).map((name) => {
              const full = normalize(state.path + '/' + name)
              return { filename: name, longname: name, attrs: attrsOf(full) }
            })
            sftp.name(reqid, names)
          })
          sftp.on('LSTAT', (reqid: number, p: string) => respondStat(reqid, p))
          sftp.on('STAT', (reqid: number, p: string) => respondStat(reqid, p))
          function respondStat(reqid: number, p: string) {
            try {
              lstatSync(p)
              sftp.attrs(reqid, attrsOf(p))
            } catch {
              sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
            }
          }
          sftp.on('FSTAT', (reqid: number, h: Buffer) => {
            const fd = fileHandles.get(idOf(h))
            if (fd == null) return sftp.status(reqid, STATUS_CODE.FAILURE)
            // Must return ATTRS — sftp.readFile uses this to size its read.
            sftp.attrs(reqid, attrsFromStats(fstatSync(fd)))
          })
          sftp.on('MKDIR', (reqid: number, p: string) => {
            try {
              mkdirSync(p)
              sftp.status(reqid, STATUS_CODE.OK)
            } catch {
              sftp.status(reqid, STATUS_CODE.FAILURE)
            }
          })
          sftp.on('RENAME', (reqid: number, from: string, to: string) => {
            try {
              renameSync(from, to)
              sftp.status(reqid, STATUS_CODE.OK)
            } catch {
              sftp.status(reqid, STATUS_CODE.FAILURE)
            }
          })
          sftp.on('REMOVE', (reqid: number, p: string) => {
            try {
              unlinkSync(p)
              sftp.status(reqid, STATUS_CODE.OK)
            } catch {
              sftp.status(reqid, STATUS_CODE.FAILURE)
            }
          })
          sftp.on('RMDIR', (reqid: number, p: string) => {
            try {
              rmdirSync(p)
              sftp.status(reqid, STATUS_CODE.OK)
            } catch {
              sftp.status(reqid, STATUS_CODE.FAILURE)
            }
          })
          sftp.on('OPEN', (reqid: number, filename: string, flags: number) => {
            try {
              const isWrite = !!(flags & OPEN_MODE.WRITE)
              const fd = openSync(filename, isWrite ? 'w' : 'r')
              const h = mkHandle()
              fileHandles.set(h.id, fd)
              sftp.handle(reqid, h.buf)
            } catch {
              sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
            }
          })
          sftp.on('READ', (reqid: number, h: Buffer, offset: number, length: number) => {
            const fd = fileHandles.get(idOf(h))
            if (fd == null) return sftp.status(reqid, STATUS_CODE.FAILURE)
            const buf = Buffer.alloc(length)
            const bytes = readSync(fd, buf, 0, length, offset)
            if (bytes === 0) return sftp.status(reqid, STATUS_CODE.EOF)
            sftp.data(reqid, buf.subarray(0, bytes))
          })
          sftp.on('WRITE', (reqid: number, h: Buffer, offset: number, data: Buffer) => {
            const fd = fileHandles.get(idOf(h))
            if (fd == null) return sftp.status(reqid, STATUS_CODE.FAILURE)
            writeSync(fd, data, 0, data.length, offset)
            sftp.status(reqid, STATUS_CODE.OK)
          })
          sftp.on('FSETSTAT', (reqid: number) => sftp.status(reqid, STATUS_CODE.OK))
          sftp.on('SETSTAT', (reqid: number) => sftp.status(reqid, STATUS_CODE.OK))
          sftp.on('CLOSE', (reqid: number, h: Buffer) => {
            const id = idOf(h)
            const fd = fileHandles.get(id)
            if (fd != null) {
              closeSync(fd)
              fileHandles.delete(id)
            }
            dirHandles.delete(id)
            sftp.status(reqid, STATUS_CODE.OK)
          })
        })
      })
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: (server.address() as AddressInfo).port, close: () => server.close() })
    })
  })
}
