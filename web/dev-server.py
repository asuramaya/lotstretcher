#!/usr/bin/env python3
"""Static dev server for the lotstretcher browser client.

Exists for one reason: cross-origin isolation. onnxruntime-web's threaded
build needs SharedArrayBuffer, which needs COOP/COEP headers, which
`python -m http.server` does not send -- so under it the app silently
runs single-threaded and everything looks mysteriously slow.

In production Cloudflare serves these from public/_headers. This mirrors
that file; if you change one, change the other.

    python3 web/dev-server.py [port]
"""
import functools
import http.server
import socketserver
import sys
from pathlib import Path

ROOT = Path(__file__).parent / "public"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8787


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("X-Content-Type-Options", "nosniff")
        # Dev only: never cache, or you will spend an hour debugging a
        # module the browser is refusing to re-fetch.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Quiet the per-asset noise; a 54MB model load is ~1 line of value.
        if "404" in (fmt % args) or "500" in (fmt % args):
            super().log_message(fmt, *args)


Handler.extensions_map.update({
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".wasm": "application/wasm",
    ".onnx": "application/octet-stream",
    ".webmanifest": "application/manifest+json",
})


def main():
    socketserver.TCPServer.allow_reuse_address = True
    handler = functools.partial(Handler, directory=str(ROOT))
    with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), handler) as httpd:
        print(f"lotstretcher dev server -> http://127.0.0.1:{PORT}")
        print(f"  serving {ROOT}")
        print("  COOP/COEP on (cross-origin isolation enabled)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")


if __name__ == "__main__":
    main()
