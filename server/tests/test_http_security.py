"""HTTP boundary tests for the market service.

Boots the real Handler on an ephemeral loopback port, so these assert what a
browser actually receives rather than what the code intends.
"""
from __future__ import annotations

import http.client
import json
import sys
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import market_service  # noqa: E402
import paper_trader  # noqa: E402


class HandlerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), market_service.Handler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def request(self, method, path, *, origin=None, body=None, host=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        headers = {"Content-Type": "application/json"}
        if origin is not None:
            headers["Origin"] = origin
        if host is not None:
            headers["Host"] = host
        conn.request(method, path, body=body, headers=headers)
        resp = conn.getresponse()
        payload = resp.read()
        conn.close()
        return resp, payload

    # -- preflight -------------------------------------------------------
    def test_preflight_refuses_foreign_origin(self):
        resp, _ = self.request("OPTIONS", "/api/paper/order",
                               origin="https://evil.example")
        self.assertNotEqual(resp.status, 204, "foreign preflight must not be approved")
        self.assertNotIn(resp.getheader("Access-Control-Allow-Origin"),
                         ("*", "https://evil.example"))

    def test_preflight_allows_loopback_origin(self):
        resp, _ = self.request("OPTIONS", "/api/paper/order",
                               origin="http://127.0.0.1:8000")
        self.assertEqual(resp.status, 204)
        self.assertEqual(resp.getheader("Access-Control-Allow-Origin"),
                         "http://127.0.0.1:8000")

    # -- writes ----------------------------------------------------------
    def test_write_refuses_foreign_origin(self):
        resp, _ = self.request("POST", "/api/paper/rails",
                               origin="https://evil.example", body="{}")
        self.assertEqual(resp.status, 403)

    def test_delete_refuses_foreign_origin(self):
        resp, _ = self.request("DELETE", "/api/trish/config",
                               origin="https://evil.example")
        self.assertEqual(resp.status, 403)

    def test_write_allows_loopback_origin(self):
        resp, _ = self.request("POST", "/api/paper/rails",
                               origin="http://127.0.0.1:8000", body="{}")
        self.assertEqual(resp.status, 200)

    def test_write_allows_origin_matching_request_host(self):
        """A dashboard served over http on a non-loopback host is same-origin.

        The dashboard points at `http://<app host>:8788`, so a page served on a
        hostname or a forwarded container port posts from that host, not from
        loopback. Refusing it would break the documented setup.
        """
        resp, _ = self.request("POST", "/api/paper/rails",
                               origin="http://mybox.local:8000",
                               host="mybox.local:8788", body="{}")
        self.assertEqual(resp.status, 200)

    def test_preflight_allows_origin_matching_request_host(self):
        resp, _ = self.request("OPTIONS", "/api/paper/order",
                               origin="http://mybox.local:8000",
                               host="mybox.local:8788")
        self.assertEqual(resp.status, 204)
        self.assertEqual(resp.getheader("Access-Control-Allow-Origin"),
                         "http://mybox.local:8000")

    def test_write_refuses_origin_from_a_different_host(self):
        """A foreign page is foreign even when a Host header is present."""
        resp, _ = self.request("POST", "/api/paper/rails",
                               origin="http://mybox.local:8000",
                               host="127.0.0.1:8788", body="{}")
        self.assertEqual(resp.status, 403)

    def test_write_without_origin_still_works(self):
        """curl and local scripts send no Origin; they must keep working."""
        resp, _ = self.request("POST", "/api/paper/rails", body="{}")
        self.assertEqual(resp.status, 200)

    # -- reads -----------------------------------------------------------
    def test_read_grants_origin_matching_request_host(self):
        resp, _ = self.request("GET", "/api/health",
                               origin="http://mybox.local:8000",
                               host="mybox.local:8788")
        self.assertEqual(resp.getheader("Access-Control-Allow-Origin"),
                         "http://mybox.local:8000")

    def test_read_refuses_wildcard_origin(self):
        resp, payload = self.request("GET", "/api/health",
                                     origin="https://evil.example")
        self.assertNotEqual(resp.getheader("Access-Control-Allow-Origin"), "*")
        self.assertNotEqual(resp.getheader("Access-Control-Allow-Origin"),
                            "https://evil.example")
        self.assertTrue(json.loads(payload)["ok"])


if __name__ == "__main__":
    unittest.main()
