#!/usr/bin/env python3
"""Serve the Citilink web app and proxy its read-only API requests.

The upstream API does not send CORS headers. Keeping the upstream request here
makes every browser request same-origin without disabling browser security.
"""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

HOST = "127.0.0.1"
PORT = 8000
API_BASE = "https://swiv.citilink.cadavl.com/SWIV/CITILINK/proxy/restWS"
APP_DIR = Path(__file__).resolve().parent


class CitilinkHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    def do_GET(self):
        request_path = urlsplit(self.path)
        if request_path.path == "/api" or request_path.path.startswith("/api/"):
            self.proxy_api(request_path)
            return
        super().do_GET()

    def proxy_api(self, request_path):
        upstream_path = request_path.path.removeprefix("/api") or "/"
        upstream_url = f"{API_BASE}{upstream_path}"
        if request_path.query:
            upstream_url = f"{upstream_url}?{request_path.query}"

        request = Request(upstream_url, headers={"Accept": "application/json"})
        try:
            with urlopen(request, timeout=15) as response:
                body = response.read()
                self.send_response(response.status)
                self.send_header("Content-Type", response.headers.get_content_type())
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        except HTTPError as error:
            body = error.read()
            self.send_response(error.code)
            self.send_header("Content-Type", error.headers.get_content_type())
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except URLError as error:
            self.send_error(502, f"Citilink API unavailable: {error.reason}")


if __name__ == "__main__":
    print(f"Citilink web app: http://{HOST}:{PORT}")
    ThreadingHTTPServer((HOST, PORT), CitilinkHandler).serve_forever()
