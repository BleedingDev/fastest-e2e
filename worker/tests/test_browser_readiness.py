"""Fixture startup must tolerate partial metadata without skipping browser checks."""
import io
import json
from pathlib import Path
from unittest import TestCase
from unittest.mock import Mock, patch
from browser_smoke import wait_for_browser


class BrowserReadinessTests(TestCase):
    def test_missing_partial_and_unready_endpoint_are_polled(self):
        browser = Mock(returncode=None)
        browser.poll.return_value = None
        opener = Mock()
        opener.open.side_effect = [
            OSError("not serving yet"),
            io.StringIO(json.dumps({"webSocketDebuggerUrl": "ws://127.0.0.1:9333/devtools/browser/other"})),
            io.StringIO(json.dumps({"webSocketDebuggerUrl": "ws://127.0.0.1:9333/devtools/browser/test"})),
        ]
        with patch.object(Path, "read_text", side_effect=[
            FileNotFoundError(), "9333", "bad metadata", *["9333\n/devtools/browser/test"] * 3,
        ]), patch("browser_smoke.urllib.request.build_opener", return_value=opener), patch("browser_smoke.time.sleep"):
            self.assertEqual(wait_for_browser(browser, Path("/fixture")), ("9333", "/devtools/browser/test"))
        self.assertEqual(opener.open.call_count, 3)
        browser.terminate.assert_not_called()

    def test_early_exit_is_reported_before_reading_metadata(self):
        browser = Mock(returncode=7)
        browser.poll.return_value = 7
        with patch.object(Path, "read_text") as read:
            with self.assertRaisesRegex(RuntimeError, r"exited before CDP readiness \(exit 7\)"):
                wait_for_browser(browser, Path("/fixture"))
            read.assert_not_called()

    def test_deadline_is_an_explicit_failure_with_bounded_diagnostics(self):
        browser = Mock()
        with patch.object(Path, "exists", return_value=True), patch.object(Path, "read_text", return_value="x" * 5000 + " startup detail"):
            with self.assertRaisesRegex(RuntimeError, "before the deadline") as error:
                wait_for_browser(browser, Path("/fixture"), Path("/fixture/chrome.log"), timeout=0)
        self.assertTrue(str(error.exception).endswith("startup detail"))
        self.assertLess(len(str(error.exception)), 4500)
        browser.poll.assert_not_called()
