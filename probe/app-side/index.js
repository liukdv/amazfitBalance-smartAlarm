// The module that runs INSIDE the Zepp app on the phone.
//
// The watch has no network of its own: this is the piece that carries the data
// out. It receives from the device over Bluetooth and forwards it to the HTTP
// receiver described in server/, so debugging no longer depends on someone
// transcribing numbers by hand off a round screen.
import { BaseSideService } from '@zeppos/zml/base-side'

// BEFORE USING IT: put YOUR OWN receiver here.
// The token in the path is the only protection of the ingest (the Zepp app does
// not let you add headers to the request), so generate a long random one and use
// the same value in server/wlog.service. Never commit the real value.
const INGEST = 'https://example.invalid/wlog/PUT-YOUR-TOKEN-HERE'

async function upload(payload, res) {
  try {
    const r = await fetch({
      url: INGEST,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    res(null, { ok: true, status: r && r.status ? r.status : 'sent' })
  } catch (e) {
    res(null, { ok: false, error: (e && e.message) || String(e) })
  }
}

AppSideService(
  BaseSideService({
    onInit() {},

    onRequest(req, res) {
      if (req.method === 'UPLOAD') {
        upload(req.payload || {}, res)
        return
      }
      res(null, { ok: false, error: 'unknown method: ' + req.method })
    },

    onRun() {},
    onDestroy() {},
  })
)
