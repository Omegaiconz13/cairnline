"""A pidfile must never make the runtime signal a process it did not start.

PID reuse is normal on a long-lived box. If the recorded pid now belongs to
something else, `state()` must report "not running" and `stop()` must not send
a signal at all.
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import trish_runtime  # noqa: E402


class StalePidfileTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.pidfile = Path(self.tmp.name) / "gateway.pid"
        self._saved = trish_runtime.PIDFILE
        trish_runtime.PIDFILE = self.pidfile
        # A live process this module certainly did not start (its own test
        # runner is not a gateway either, but a fresh interpreter is cleaner).
        self.other = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])

    def tearDown(self):
        trish_runtime.PIDFILE = self._saved
        self.other.terminate()
        try:
            self.other.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.other.kill()
        self.tmp.cleanup()

    def test_foreign_pid_with_wrong_start_time_is_not_running(self):
        self.pidfile.write_text(f"{self.other.pid} 1")
        self.assertIsNone(trish_runtime._pid())

    def test_legacy_pidfile_for_a_foreign_process_is_not_running(self):
        self.pidfile.write_text(str(self.other.pid))  # pre-upgrade format
        self.assertIsNone(trish_runtime._pid())

    def test_stop_does_not_signal_a_foreign_process(self):
        self.pidfile.write_text(f"{self.other.pid} 1")
        result = trish_runtime.stop()
        self.assertFalse(result["stopped"])
        self.assertIsNone(self.other.poll(), "the unrelated process must still be alive")

    def test_matching_start_time_is_accepted(self):
        start = trish_runtime._proc_start(self.other.pid)
        if start is None:                      # no /proc on this platform
            self.skipTest("/proc is unavailable")
        self.pidfile.write_text(f"{self.other.pid} {start}")
        self.assertEqual(trish_runtime._pid(), self.other.pid)


if __name__ == "__main__":
    unittest.main()
