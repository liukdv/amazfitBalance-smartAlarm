// STUB @zos/router
export function push(opts) {
  const s = globalThis.__stub || {}
  if (s.throwPush) throw new Error('router unavailable')
  s.pushed = (s.pushed || []).concat([opts && opts.url])
}

export function launchApp() {}
export function replace(opts) {
  const s = globalThis.__stub || {}
  if (s.throwReplace) throw new Error('replace unavailable')
  s.replaced = (s.replaced || []).concat([opts && opts.url])
}
export function back() {
  const s = globalThis.__stub || {}
  if (s.throwBack) throw new Error('back unavailable')
  s.backCalls = (s.backCalls || 0) + 1
}
export function home() {
  const s = globalThis.__stub || {}
  if (s.throwHome) throw new Error('home unavailable')
  s.homeCalls = (s.homeCalls || 0) + 1
}
