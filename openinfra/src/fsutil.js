import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export async function mkdirp(dir) {
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

export function mkdirpSync(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback
    if (err.code === 'ENOENT') throw err
    throw new Error(`${file}: ${err.message}`)
  }
}

/** Write via a temp file in the same directory then rename: a crash never leaves half a file. */
export async function writeAtomic(file, data, { mode = 0o644 } = {}) {
  await mkdirp(path.dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
  await fsp.writeFile(tmp, data, { mode })
  await fsp.rename(tmp, file)
  return file
}

export function writeAtomicSync(file, data, { mode = 0o644 } = {}) {
  mkdirpSync(path.dirname(file))
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  fs.writeFileSync(tmp, data, { mode })
  fs.renameSync(tmp, file)
  return file
}

export async function appendLine(file, line) {
  await mkdirp(path.dirname(file))
  const fd = await fsp.open(file, 'a')
  try {
    await fd.write(line.endsWith('\n') ? line : line + '\n')
    await fd.sync()
  } finally {
    await fd.close()
  }
}

export function appendLineSync(file, line) {
  mkdirpSync(path.dirname(file))
  const fd = fs.openSync(file, 'a')
  try {
    fs.writeSync(fd, line.endsWith('\n') ? line : line + '\n')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

export function readLines(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return { malformed: true, raw: l }
        }
      })
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
}

export async function exists(p) {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

/** A network filesystem breaks SQLite locking and git performance; OpenInfra refuses to host a workspace there. */
export function networkFilesystem(dir) {
  if (process.platform !== 'linux') return null
  try {
    const mounts = fs.readFileSync('/proc/mounts', 'utf8').split('\n')
    const target = fs.realpathSync(dir)
    let best = null
    for (const line of mounts) {
      const [dev, mountPoint, fstype] = line.split(' ')
      if (!mountPoint) continue
      const mp = mountPoint.replace(/\\040/g, ' ')
      if ((target === mp || target.startsWith(mp + '/')) && (!best || mp.length > best.mount.length)) {
        best = { mount: mp, fstype, dev }
      }
    }
    const net = ['nfs', 'nfs4', 'cifs', 'smb3', 'smbfs', '9p', 'fuse.sshfs', 'ceph', 'glusterfs']
    if (best && net.some((t) => best.fstype === t || best.fstype.startsWith(t))) return best
  } catch {
    /* best effort */
  }
  return null
}

export function expandHome(p, home = os.homedir()) {
  if (!p) return p
  if (p === '~') return home
  if (p.startsWith('~/')) return path.join(home, p.slice(2))
  return p
}

export function shortHash(s, len = 8) {
  return String(s).replace(/[^a-z0-9]/gi, '').slice(0, len)
}
