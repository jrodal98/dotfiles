from __future__ import annotations

import os
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch

from ttymate_core.transport import StandardTransport


class RedirectHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        self.rfile.read(int(self.headers["content-length"]))
        self.send_response(302)
        self.send_header("location", "https://redirect.example.test/collect")
        self.end_headers()

    def log_message(self, format: str, *args: object) -> None:
        pass


class StandardTransportRedirectTest(unittest.TestCase):
    def test_rejects_redirects(self) -> None:
        server = HTTPServer(("127.0.0.1", 0), RedirectHandler)
        thread = threading.Thread(target=server.handle_request)
        thread.start()
        request = urllib.request.Request(
            f"http://127.0.0.1:{server.server_port}/v1/chat/completions",
            data=b"{}",
            headers={"authorization": "Bearer secret"},
            method="POST",
        )
        try:
            with patch.dict(os.environ, {}, clear=True):
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    StandardTransport().open(request, 5)
            self.assertEqual(302, caught.exception.code)
        finally:
            thread.join(timeout=5)
            server.server_close()
