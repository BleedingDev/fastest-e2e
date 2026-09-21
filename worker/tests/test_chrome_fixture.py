"""No browser/network required: test readiness timing and fail-closed identity checks."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

from chrome_fixture import EndpointMismatch, probe_endpoint, read_endpoint, stop_process, wait_for_endpoint

BROWSER_PATH = "/devtools/browser/fixture-id"


class Clock:
    def __init__(self):
        self.now = 0.0
        self.on_sleep = lambda: None

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds
        self.on_sleep()


class ReadinessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.active = Path(self.temp.name) / "DevToolsActivePort"
        self.browser = Mock(returncode=None)
        self.browser.poll.return_value = None
        self.clock = Clock()

    def write(self):
        self.active.write_text(f"9333\n{BROWSER_PATH}\n")

    def wait(self, probe=None, timeout=30):
        return wait_for_endpoint(self.browser, self.active, timeout=timeout,
            probe=probe or Mock(), clock=self.clock, sleep=self.clock.sleep)

    def test_slow_start_and_partial_file_do_not_cause_premature_read(self):
        def progress():
            if self.clock.now < 12:
                self.active.write_text("9333\n")
            else:
                self.write()
        self.clock.on_sleep = progress
        probe = Mock()
        self.assertEqual(self.wait(probe), (9333, BROWSER_PATH))
        self.assertGreaterEqual(self.clock.now, 12)
        self.assertLess(self.clock.now, 13)
        probe.assert_called_once()

    def test_file_alone_is_not_readiness(self):
        self.write()
        probe = Mock(side_effect=[ConnectionRefusedError(), json.JSONDecodeError("partial", "", 0), None])
        self.assertEqual(self.wait(probe), (9333, BROWSER_PATH))
        self.assertEqual(probe.call_count, 3)

    def test_early_exit_is_reported_immediately(self):
        self.browser.poll.return_value = 7
        self.browser.returncode = 7
        with self.assertRaisesRegex(RuntimeError, "exit 7"):
            self.wait()
        self.assertEqual(self.clock.now, 0)

    def test_deadline_is_bounded_and_diagnostic(self):
        with self.assertRaisesRegex(TimeoutError, "verified CDP within 0.2s"):
            self.wait(timeout=0.2)
        self.assertAlmostEqual(self.clock.now, 0.2)

    def test_probe_uses_only_remaining_budget(self):
        self.write()
        def stalled(_port, _path, timeout):
            self.clock.sleep(timeout)
            raise TimeoutError()
        with self.assertRaises(TimeoutError):
            self.wait(stalled, timeout=0.2)
        self.assertAlmostEqual(self.clock.now, 0.2)

    def test_identity_mismatch_is_not_retried(self):
        self.write()
        probe = Mock(side_effect=EndpointMismatch("different browser"))
        with self.assertRaisesRegex(EndpointMismatch, "different browser"):
            self.wait(probe)
        probe.assert_called_once()

    def test_endpoint_change_during_probe_is_rejected(self):
        self.write()
        def swap(*_):
            self.active.write_text("9334\n/devtools/browser/another\n")
        with self.assertRaisesRegex(EndpointMismatch, "changed during startup"):
            self.wait(swap)

    def test_strict_endpoint_syntax(self):
        for text in ["", "9333\n", "9e3\n"+BROWSER_PATH, "65536\n"+BROWSER_PATH,
                     "0\n"+BROWSER_PATH, "9333\nhttps://other.example", "9333\n"+BROWSER_PATH+"\nextra"]:
            with self.subTest(text=text):
                self.active.write_text(text)
                with self.assertRaises(ValueError):
                    read_endpoint(self.active)

    def test_http_probe_verifies_browser_identity(self):
        response = Mock(status=200)
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = json.dumps({"webSocketDebuggerUrl": "ws://127.0.0.1:9333/devtools/browser/other"}).encode()
        with patch("chrome_fixture.urllib.request.build_opener") as build:
            build.return_value.open.return_value = response
            with self.assertRaises(EndpointMismatch):
                probe_endpoint(9333, BROWSER_PATH, 0.5)

    def test_cleanup_waits_and_escalates_only_owned_child(self):
        self.browser.wait.side_effect = [subprocess.TimeoutExpired("fixture", 5), 0]
        stop_process(self.browser)
        self.browser.terminate.assert_called_once()
        self.browser.kill.assert_called_once()
        self.assertEqual(self.browser.wait.call_count, 2)

    def test_cleanup_does_not_signal_exited_child(self):
        self.browser.poll.return_value = 0
        stop_process(self.browser)
        self.browser.terminate.assert_not_called()


if __name__ == "__main__":
    unittest.main()
