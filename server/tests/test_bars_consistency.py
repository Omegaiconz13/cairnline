"""Bars served to a route must equal the bars the analysis engines get.

The 4h resample used to live in one place and be hand-copied everywhere else,
so the chart and the backtest disagreed on 4h. These pin the single source.
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

SOURCE = (Path(__file__).resolve().parents[1] / "market_service.py").read_text()


def hourly(n=40):
    return [{"openTime": 1_700_000_000_000 + i * 3_600_000,
             "open": 1.0 + i, "high": 1.5 + i, "low": 0.5 + i,
             "close": 1.2 + i, "volume": 10} for i in range(n)]


class BarsConsistencyTest(unittest.TestCase):
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

    def setUp(self):
        self._saved = (market_service.fetch_lse_candles, market_service.fetch_candles,
                       market_service.cache_get, market_service.cache_put)
        market_service.fetch_lse_candles = lambda *a, **k: []
        market_service.fetch_candles = lambda symbol, interval, period: hourly()
        market_service.cache_get = lambda *a, **k: None
        market_service.cache_put = lambda *a, **k: None

    def tearDown(self):
        (market_service.fetch_lse_candles, market_service.fetch_candles,
         market_service.cache_get, market_service.cache_put) = self._saved

    def test_live_bars_resamples_one_hour_into_four(self):
        bars, source = market_service.live_bars("EURUSD", "4h", "3mo")
        self.assertEqual(source, "yfinance")
        self.assertEqual(len(bars), 10)          # 40 hourly bars -> 10 full buckets
        self.assertEqual(bars[0]["open"], 1.0)
        self.assertEqual(bars[0]["close"], 4.2)  # close of the 4th hourly bar

    def test_candles_route_serves_the_same_four_hour_bars(self):
        expected, _ = market_service.live_bars("EURUSD", "4h", "3mo")
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("GET", "/api/candles?symbol=EURUSD&interval=4h&range=3mo")
        resp = conn.getresponse()
        payload = json.loads(resp.read())
        conn.close()
        self.assertEqual(resp.status, 200)
        self.assertEqual(payload["bars"], expected)

    def test_the_resample_is_written_once(self):
        self.assertEqual(SOURCE.count("aggregate_bars(fetch_candles"), 1,
                         "the 4h chain must exist only inside live_bars()")


if __name__ == "__main__":
    unittest.main()
