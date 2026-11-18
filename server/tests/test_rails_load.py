"""Rails are validated on write, so a rail file on disk must be validated too.

`set_rails` refuses a non-finite or over-ceiling rail, but `_load` merged the
stored values over `DEFAULT_RAILS` without looking at them. Anything already on
disk therefore ran unchecked: a state file written before the ceilings existed,
or one edited by hand, could still hand the gate `max_daily_loss_pct: 1000` or
`max_open_positions: Infinity` (Python's json accepts `Infinity`).

Loading cannot raise — a bad file must not take the desk down — so an
unacceptable stored value falls back to the default instead of being refused.
A valid tightened rail is still the user's, and survives.
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import paper_trader  # noqa: E402


class RailsLoadTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._saved = (paper_trader.STATE_DIR, paper_trader.STATE_PATH)
        paper_trader.STATE_DIR = Path(self.tmp.name)
        paper_trader.STATE_PATH = Path(self.tmp.name) / "paper.json"

    def tearDown(self):
        paper_trader.STATE_DIR, paper_trader.STATE_PATH = self._saved
        self.tmp.cleanup()

    def _write(self, rails: dict) -> dict:
        paper_trader.STATE_PATH.write_text(json.dumps({"account": {}, "rails": rails}))
        return paper_trader._load()["rails"]

    def test_a_stored_rail_past_its_ceiling_falls_back_to_the_default(self):
        rails = self._write({"max_daily_loss_pct": 1000, "max_open_positions": 10_000})
        self.assertEqual(rails["max_daily_loss_pct"], paper_trader.DEFAULT_RAILS["max_daily_loss_pct"])
        self.assertEqual(rails["max_open_positions"], paper_trader.DEFAULT_RAILS["max_open_positions"])

    def test_a_stored_non_finite_rail_falls_back_to_the_default(self):
        # json.dumps writes bare Infinity/NaN, which json.loads reads back.
        paper_trader.STATE_PATH.write_text(
            '{"account": {}, "rails": {"max_risk_pct_per_trade": Infinity, "max_daily_loss_pct": NaN}}'
        )
        rails = paper_trader._load()["rails"]
        self.assertEqual(rails["max_risk_pct_per_trade"], paper_trader.DEFAULT_RAILS["max_risk_pct_per_trade"])
        self.assertEqual(rails["max_daily_loss_pct"], paper_trader.DEFAULT_RAILS["max_daily_loss_pct"])

    def test_a_stored_text_number_is_coerced_to_a_number(self):
        rails = self._write({"max_open_positions": "5", "max_daily_loss_pct": "1.5"})
        self.assertEqual(rails["max_open_positions"], 5)
        self.assertIsInstance(rails["max_open_positions"], int)
        self.assertEqual(rails["max_daily_loss_pct"], 1.5)
        self.assertIsInstance(rails["max_daily_loss_pct"], float)

    def test_a_tightened_rail_on_disk_is_kept(self):
        rails = self._write({"max_daily_loss_pct": 1.5, "max_open_positions": 1})
        self.assertEqual(rails["max_daily_loss_pct"], 1.5)
        self.assertEqual(rails["max_open_positions"], 1)

    def test_an_unknown_stored_rail_is_dropped(self):
        rails = self._write({"nonsense_rail": 1, "symbol_allowlist": ["eurusd"]})
        self.assertNotIn("nonsense_rail", rails)
        self.assertEqual(rails["symbol_allowlist"], ["EURUSD"])

    def test_bad_shape_falls_back_rail_by_rail(self):
        rails = self._write({"trading_hours_utc": "9-17", "min_reward_risk": None})
        self.assertEqual(rails["trading_hours_utc"], paper_trader.DEFAULT_RAILS["trading_hours_utc"])
        self.assertEqual(rails["min_reward_risk"], paper_trader.DEFAULT_RAILS["min_reward_risk"])


if __name__ == "__main__":
    unittest.main()
