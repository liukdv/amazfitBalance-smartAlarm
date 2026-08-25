// STUB @zeppos/zml/base-page — wraps the page definition and provides
// this.request(), which in the real runtime talks to the phone over Bluetooth.
export function BasePage(def) {
  return {
    ...def,
    request(msg) {
      const s = globalThis.__stub || {}
      s.requests = (s.requests || []).concat([msg])
      if (s.requestFails) return Promise.reject(new Error('phone unreachable'))
      return Promise.resolve(s.requestReply || { ok: true, status: 200 })
    },
  }
}
