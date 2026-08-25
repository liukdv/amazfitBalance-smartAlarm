// STUB @zos/fs — in-memory filesystem that imitates the quirks of the real one:
// numeric fds and writeSync with an absolute `position`.
export const O_RDONLY = 0
export const O_WRONLY = 1
export const O_RDWR = 2
export const O_CREAT = 64
export const O_APPEND = 1024

const files = new Map()
let nextFd = 3
const open = new Map()

export function __reset() {
  files.clear()
  open.clear()
  nextFd = 3
}
export function __get(path) {
  const b = files.get(path)
  return b ? Buffer.from(b).toString('binary') : null
}
export function __openCount() {
  return open.size
}

export function openSync({ path, flag }) {
  const s = globalThis.__stub || {}
  if (s.throwFsOpen) throw new Error('open boom')
  if (!files.has(path)) {
    if (!(flag & O_CREAT)) throw new Error('ENOENT ' + path)
    files.set(path, new Uint8Array(0))
  }
  const fd = nextFd++
  open.set(fd, path)
  return fd
}

export function statSync({ path }) {
  if (!files.has(path)) throw new Error('ENOENT ' + path)
  return { size: files.get(path).length }
}

export function writeSync({ fd, buffer, offset = 0, length, position = 0 }) {
  const s = globalThis.__stub || {}
  if (s.throwFsWrite) throw new Error('write boom')
  const path = open.get(fd)
  if (!path) throw new Error('EBADF')
  const src = new Uint8Array(buffer, offset, length === undefined ? undefined : length)
  const cur = files.get(path)
  const end = Math.max(cur.length, position + src.length)
  const next = new Uint8Array(end)
  next.set(cur, 0)
  next.set(src, position)
  files.set(path, next)
  return 0
}

export function readSync({ fd, buffer, offset = 0, length, position = 0 }) {
  const path = open.get(fd)
  if (!path) throw new Error('EBADF')
  const cur = files.get(path)
  const view = new Uint8Array(buffer)
  const n = Math.min(length === undefined ? cur.length : length, cur.length - position)
  for (let i = 0; i < n; i++) view[offset + i] = cur[position + i]
  return 0
}

export function closeSync({ fd }) {
  open.delete(fd)
  return 0
}

export function rmSync({ path }) {
  const s = globalThis.__stub || {}
  if (s.throwFsRm) throw new Error('rm boom')
  files.delete(path)
  return 0
}
