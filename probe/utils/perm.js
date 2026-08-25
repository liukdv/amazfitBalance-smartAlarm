// Runtime permissions.
//
// A trap that cost us a failing test: declaring the permission in app.json is
// NOT enough. The documentation is explicit — "before using system-related
// functional interface (such as the interface to enable app services), do the
// relevant permission check and application, otherwise the functional interface
// will not be allowed to execute". Without requestPermission the background
// service is blocked silently: no error, it simply never starts.
import { requestPermission, queryPermission } from '@zos/app'

export const NEEDED = ['device:os.bg_service', 'data:user.hd.sleep', 'data:user.hd.heart_rate']

// 0 = pending (arrives through the callback) · 1 = not requestable · 2 = already granted
export function checkPermissions() {
  try {
    if (typeof queryPermission !== 'function') return { known: false, states: [] }
    const states = queryPermission({ permissions: NEEDED })
    return { known: true, states: Array.isArray(states) ? states : [states] }
  } catch (e) {
    return { known: false, states: [], error: e && e.message }
  }
}

export function askPermissions(cb) {
  try {
    const r = requestPermission({
      permissions: NEEDED,
      callback: (res) => {
        try {
          cb && cb({ ok: true, code: 'callback', res })
        } catch (e) {}
      },
    })
    return { ok: true, code: r }
  } catch (e) {
    return { ok: false, code: 'err', error: e && e.message ? e.message : String(e) }
  }
}

export function summarize(states) {
  if (!states || !states.length) return 'unknown'
  return states
    .map((s, i) => NEEDED[i].split('.').pop() + '=' + s)
    .join(' ')
}
