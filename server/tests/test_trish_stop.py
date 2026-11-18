"""`stop()` must not claim success while the gateway is still running.

It waits ~5 s for the process to exit, then deleted the pidfile and returned
`stopped: True` regardless. A gateway that ignores SIGTERM (or is slow) then
looks stopped while it still owns port 8642, and the next `start()` spawns a
second one.
"""
from __future__ import annotations

import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import trish_runtime  # noqa: E402


class StubbornGatewayTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.pidfile = Path(self.tmp.name) / "gateway.pid"
        self.ready = Path(self.tmp.name) / "ready"
        self._saved = trish_runtime.PIDFILE
        trish_runtime.PIDFILE = self.pidfile
        # The child announces readiness only once SIGTERM is ignored. Waiting on
        # /proc instead is a race: interpreter startup takes 0.1-0.2 s idle and
        # up to ~0.8 s under load, so a SIGTERM can arrive first, kill the child
        # by default action, and fail this test for the wrong reason.
        self.stubborn = subprocess.Popen(
            [sys.executable, "-c",
             "import signal, sys, time;"
             " signal.signal(signal.SIGTERM, signal.SIG_IGN);"
             " open(sys.argv[1], 'w').close();"
             " time.sleep(60)", str(self.ready)])
        deadline = time.monotonic() + 30
        while not self.ready.exists():
            if self.stubborn.poll() is not None:
                self.fail("gateway stub exited before installing its SIGTERM handler")
            if time.monotonic() > deadline:
                self.fail("gateway stub never installed its SIGTERM handler")
            time.sleep(0.005)
        start = trish_runtime._proc_start(self.stubborn.pid)
        if start is None:
            self.skipTest("/proc is unavailable")
        self.pidfile.write_text(f"{self.stubborn.pid} {start}")

    def tearDown(self):
        trish_runtime.PIDFILE = self._saved
        self.stubborn.kill()
        self.stubborn.wait(timeout=5)
        self.tmp.cleanup()

    def test_survivor_is_reported_and_its_pidfile_kept(self):
        result = trish_runtime.stop()
        self.assertFalse(result["stopped"])
        self.assertTrue(self.pidfile.exists(), "the pidfile still names a live process")
        self.assertIsNone(self.stubborn.poll(), "SIGTERM was ignored, so it is still alive")


if __name__ == "__main__":
    unittest.main()
