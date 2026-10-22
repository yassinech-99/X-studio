/**
 * Content-addressed artifact store. Anything too big for a tool result, a diff, a plan, a device config dump or
 * a job's output lives here and is referenced by sha256. Deduplicated by construction, compressed on disk.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { paths } from './paths.js'
import { redact } from './redact.js'

const compress = typeof zlib.zstdCompressSync === 'function'
  ? (buf) => zlib.zstdCompressSync(buf)
  : (buf) => zlib.gzipSync(buf, { level: 6 })
const decompress = typeof zlib.zstdDecompressSync === 'function'
  ? (buf) => zlib.zstdDecompressSync(buf)
  : (buf) => zlib.gunzipSync(buf)

export const COMPRESSION = typeof zlib.zstdCompressSync === 'function' ? 'zstd' : 'gzip'

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

export class ArtifactStore {
  constructor({ root = paths.artifacts } = {}) {
    this.root = root
  }

  blobPath(sha) {
    return path.join(this.root, 'sha256', sha.slice(0, 2), sha.slice(2))
  }

  /** Store text or bytes; returns the descriptor every other part of the system refers to. */
  async put(data, { kind = 'text', label = null, redacted = true } = {}) {
    let buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data))
    if (redacted && !Buffer.isBuffer(data)) buf = Buffer.from(redact(buf.toString('utf8')))
    const digest = sha256(buf)
    const file = this.blobPath(digest)
    if (!fs.existsSync(file)) {
      await fsp.mkdir(path.dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      await fsp.writeFile(tmp, compress(buf))
      await fsp.rename(tmp, file)
    }
    return { sha256: digest, size: buf.length, stored: fs.statSync(file).size, kind, label, compression: COMPRESSION }
  }

  putSync(data, opts = {}) {
    let buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data))
    if (opts.redacted !== false && !Buffer.isBuffer(data)) buf = Buffer.from(redact(buf.toString('utf8')))
    const digest = sha256(buf)
    const file = this.blobPath(digest)
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(`${file}.tmp`, compress(buf))
      fs.renameSync(`${file}.tmp`, file)
    }
    return { sha256: digest, size: buf.length, kind: opts.kind || 'text', label: opts.label || null, compression: COMPRESSION }
  }

  async get(sha) {
    const file = this.blobPath(sha)
    return decompress(await fsp.readFile(file))
  }

  getSync(sha) {
    return decompress(fs.readFileSync(this.blobPath(sha)))
  }

  getTextSync(sha) {
    return this.getSync(sha).toString('utf8')
  }

  has(sha) {
    return fs.existsSync(this.blobPath(sha))
  }

  async gc({ keep = new Set(), olderThanMs = 90 * 24 * 3600 * 1000 } = {}) {
    const removed = []
    const base = path.join(this.root, 'sha256')
    if (!fs.existsSync(base)) return removed
    const cutoff = Date.now() - olderThanMs
    for (const prefix of await fsp.readdir(base)) {
      const dir = path.join(base, prefix)
      for (const name of await fsp.readdir(dir)) {
        const sha = prefix + name
        const file = path.join(dir, name)
        const st = await fsp.stat(file)
        if (!keep.has(sha) && st.mtimeMs < cutoff) {
          await fsp.rm(file, { force: true })
          removed.push(sha)
        }
      }
    }
    return removed
  }
}

let cached = null
/** Resolved lazily so a test (or a migrated home) can point OPENINFRA_HOME somewhere else mid-process. */
export function defaultArtifacts() {
  const root = paths.artifacts
  if (!cached || cached.root !== root) cached = new ArtifactStore({ root })
  return cached
}
