"""The percentage rails must fail closed when there is no equity to measure against.

`max_risk_pct_per_trade` and `max_position_notional_pct` are ratios over equity,
and equity is `balance` plus nothing else at submit time. Once balance reaches
zero or goes negative the ratio is `0.0` or *negative*, which is comfortably
below the ceiling — so the rails that exist to bound an order both reported a
pass and the order was accepted:

    balance = 0.0    risk_pct =   0.00  -> accepted
    balance = -500   risk_pct = -202.20 -> accepted

A blown account is exactly when the gate matters most, so a non-positive equity
is a refusal, not a free pass.
"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import paper_trader  # noqa: E402

PROPOSAL = {
    "symbol": "EURUSD",
    "side": "long",
    "units": 100_000,
    "stop": 1.09,
    "target": 1.13,
    "reason": "test",
}


class EquityRailsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._saved = (paper_trader.STATE_DIR, paper_trader.STATE_PATH)
        paper_trader.STATE_DIR = Path(self.tmp.name)
        paper_trader.STATE_PATH = Path(self.tmp.name) / "paper.json"
        paper_trader.bind(
            quotes=lambda symbols: {s: {"price": 1.1, "source": "test"} for s in symbols},
            bars=lambda *args: [],
        )

    def tearDown(self):
        paper_trader.bind(quotes=None, bars=None)
        paper_trader.STATE_DIR, paper_trader.STATE_PATH = self._saved
        self.tmp.cleanup()

    def _submit_at(self, balance: float) -> dict:
        paper_trader._save({"account": paper_trader._empty_account(balance),
                            "rails": paper_trader.DEFAULT_RAILS})
        return paper_trader.submit(dict(PROPOSAL))

    def test_zero_equity_refuses_on_the_percentage_rails(self):
        out = self._submit_at(0.0)
        self.assertFalse(out["accepted"], out.get("reasons"))
        failed = {c["key"] for c in out["order"]["checks"] if not c["pass"]}
        self.assertIn("risk_per_trade", failed)
        self.assertIn("notional", failed)

    def test_negative_equity_refuses_on_the_percentage_rails(self):
        out = self._submit_at(-500.0)
        self.assertFalse(out["accepted"], out.get("reasons"))
        failed = {c["key"] for c in out["order"]["checks"] if not c["pass"]}
        self.assertIn("risk_per_trade", failed)
        self.assertIn("notional", failed)

    def test_a_funded_account_still_prices_the_same_order(self):
        """The refused order above is refused for the ratio, not for its size."""
        out = self._submit_at(10_000.0)
        failed = {c["key"] for c in out["order"]["checks"] if not c["pass"]}
        self.assertIn("risk_per_trade", failed)
        self.assertAlmostEqual(out["order"]["risk_pct"], 10.11, places=2)

    def test_a_properly_sized_order_is_still_accepted(self):
        """Failing closed on a blown account must not tighten the normal path."""
        sized = dict(PROPOSAL, units=900)
        paper_trader._save({"account": paper_trader._empty_account(10_000.0),
                            "rails": paper_trader.DEFAULT_RAILS})
        out = paper_trader.submit(sized)
        self.assertTrue(out["accepted"], out.get("reasons"))
        self.assertEqual(out["position"]["symbol"], "EURUSD")


if __name__ == "__main__":
    unittest.main()
