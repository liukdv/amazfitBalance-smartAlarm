"""Receiver for the watch logs.

It sits on a small server behind nginx. The watch has no network of its own: the
data arrives from the module running inside the Zepp app on the phone, which
POSTs here.

It writes one JSON line per event into /var/log/wlog/watch.jsonl, which you read
over ssh. Nothing is readable over the web: the ingest is open (protected only by
the token in the path), and the content is inspected on the server.
"""
import json
import os
import sys
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("WLOG_PORT", "8096"))
LOG_PATH = os.environ.get("WLOG_FILE", "/var/log/wlog/watch.jsonl")
TOKEN = os.environ.get("WLOG_TOKEN", "")
MAX_BODY = 256 * 1024

os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)


UPLOAD_DIR = os.path.join(os.path.dirname(LOG_PATH), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

_seq = [0]


def append(record):
    now = datetime.now(timezone.utc)
    record["_received"] = now.isoformat()

    # One line in the single register: convenient to read in sequence.
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")

    # And a copy in a file with a name of its own: no upload can overwrite
    # another, and the watch's sequence number stays in the filename.
    _seq[0] += 1
    stamp = now.strftime("%Y%m%dT%H%M%S")
    wseq = record.get("seq", "x")
    name = "watch-%s-seq%s-%03d.json" % (stamp, wseq, _seq[0])
    with open(os.path.join(UPLOAD_DIR, name), "w", encoding="utf-8") as f:
        json.dump(record, f, ensure_ascii=False, indent=1)
    return name


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _reply(self, code, body=b"ok"):
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    # The token travels in the path: the Zepp app does not let you add arbitrary
    # headers as conveniently, and this channel is write-only anyway.
    def _token_ok(self):
        if not TOKEN:
            return True
        return self.path.rstrip("/").endswith("/" + TOKEN)

    def do_GET(self):
        # Liveness probe, to check the chain without sending any data.
        if self.path.rstrip("/").endswith("/ping"):
            return self._reply(200, b"wlog alive")
        return self._reply(404, b"no")

    def do_POST(self):
        if not self._token_ok():
            return self._reply(403, b"token")
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0 or n > MAX_BODY:
            return self._reply(400, b"size")
        raw = self.rfile.read(n)
        try:
            payload = json.loads(raw.decode("utf-8", "replace"))
        except Exception:
            payload = {"raw": raw.decode("utf-8", "replace")}
        if not isinstance(payload, dict):
            payload = {"payload": payload}
        try:
            append(payload)
        except Exception as e:
            return self._reply(500, str(e).encode())
        return self._reply(200, b"ok")

    def log_message(self, *args):
        pass  # no noise in the journal: the content lives in the jsonl


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("wlog listening on 127.0.0.1:%d -> %s" % (PORT, LOG_PATH), file=sys.stderr)
    srv.serve_forever()
