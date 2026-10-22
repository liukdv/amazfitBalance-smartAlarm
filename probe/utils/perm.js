// Runtime permissions.
//
// A trap that cost us a failing test: declaring the permission in app.json is
// NOT enough. The documentation is explicit — "before using system-related
// functional interface (such as the interface to enable app services), do the
// relevant permission check and application, otherwise the functional interface
// will not be allowed to execute". Without requestPermission the background
// service is blocked silently: no error, it simply never starts.
import { requestPermission } from '@zos/app'

export const NEEDED = ['device:os.bg_service']

/** Request access needed to run scheduled alarm services. */
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
