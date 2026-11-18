"""A POST body is not read on trust.

`_body()` did `self.rfile.read(int(Content-Length))` with no ceiling, so any
caller could make the service buffer an arbitrary amount of memory — and a
declared length with no bytes behind it parks a worker thread on the socket.
The limit is checked before the read.
"""
from __future__ import annotations

import http.client
import json
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import market_service  # noqa: E402
import paper_trader  # noqa: E402


class BodyLimitTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls._saved = (paper_trader.STATE_DIR, paper_trader.STATE_PATH)
        paper_trader.STATE_DIR = Path(cls.tmp.name)
        paper_trader.STATE_PATH = Path(cls.tmp.name) / "paper.json"
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), market_service.Handler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)
        paper_trader.STATE_DIR, paper_trader.STATE_PATH = cls._saved
        cls.tmp.cleanup()

    def post(self, path, body: bytes):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("POST", path, body=body, headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        payload = resp.read()
        conn.close()
        return resp, payload

    def test_an_oversized_body_is_refused(self):
        oversized = b'{"rails":{}}' + b" " * (market_service.MAX_BODY + 1)
        resp, payload = self.post("/api/paper/rails", oversized)
        self.assertEqual(resp.status, 413)
        self.assertIn("error", json.loads(payload))

    def test_a_normal_body_is_still_accepted(self):
        resp, _ = self.post("/api/paper/rails", b'{"rails":{"max_daily_loss_pct":1.5}}')
        self.assertEqual(resp.status, 200)


if __name__ == "__main__":
    unittest.main()
