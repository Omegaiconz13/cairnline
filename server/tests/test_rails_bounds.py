"""Rails are the risk gate, so a rail cannot be configured out of existence.

`set_rails` only refused negative numbers, which let two things through:

  * a non-finite value (`nan`, `inf`) — `nan < 0` is False, so it was accepted
    and then every `<= rail + 1e-9` comparison against it became False;
  * an arbitrarily large value — `max_daily_loss_pct: 1000` is not a rail.

Tightening always stays legal; only widening past a ceiling is refused.
"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import paper_trader  # noqa: E402


class RailsBoundsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._saved = (paper_trader.STATE_DIR, paper_trader.STATE_PATH)
        paper_trader.STATE_DIR = Path(self.tmp.name)
        paper_trader.STATE_PATH = Path(self.tmp.name) / "paper.json"

    def tearDown(self):
        paper_trader.STATE_DIR, paper_trader.STATE_PATH = self._saved
        self.tmp.cleanup()

    def test_non_finite_values_are_refused(self):
        for value in (float("nan"), float("inf"), "-inf"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                paper_trader.set_rails({"max_daily_loss_pct": value})

    def test_a_rail_cannot_be_widened_past_its_ceiling(self):
        with self.assertRaises(ValueError):
            paper_trader.set_rails({"max_daily_loss_pct": 1000})
        with self.assertRaises(ValueError):
            paper_trader.set_rails({"max_open_positions": 10_000})

    def test_tightening_a_rail_still_works(self):
        rails = paper_trader.set_rails({"max_daily_loss_pct": 1.5})["rails"]
        self.assertEqual(rails["max_daily_loss_pct"], 1.5)


if __name__ == "__main__":
    unittest.main()
