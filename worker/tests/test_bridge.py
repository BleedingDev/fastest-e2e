import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from types import ModuleType
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bridge


class FakeBrowser:
    target = "task-123"
    session = "session-123"
    closed = False


class FakeAgent:
    instance = None

    def __init__(self, *args, **kwargs):
        self.browser = FakeBrowser()
        self.state = {"status": "ready", "history": [], "elapsed_ms": 1}
        FakeAgent.instance = self

    def command(self, name):
        self.state["status"] = "done"
        self.state["history"].append({})

    def close(self):
        self.browser.closed = True


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {"FASTEST_E2E_TARGET_DIR": self.directory.name, "FASTEST_E2E_BROWSER_ID": "browser-123"})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.directory.cleanup()

    def cdp(self, method, **kwargs):
        if method == "Runtime.evaluate":
            value = "https://example.com" if kwargs["expression"] == "location.href" else []
            return {"result": {"value": value}}
        return {}

    def request(self, **updates):
        return {"op": "test", "url": "https://example.com", "goal": "Read the page", "checks": [{"kind": "text", "value": "Saved"}], **updates}

    def test_done_is_not_a_test_pass(self):
        self.assertEqual(bridge.verdict("done", [], False), "done")
        self.assertEqual(bridge.verdict("done", [], True), "blocked")
        self.assertEqual(bridge.verdict("done", [{"passed": False}], True), "failed")
        self.assertEqual(bridge.verdict("blocked", [{"passed": True}], True), "blocked")
        self.assertEqual(bridge.verdict("done", [{"passed": True}], True), "passed")

    def test_empty_checks_stop_before_browser_creation(self):
        with self.assertRaises(bridge.BridgeError):
            bridge.execute_agent(self.request(checks=[]), FakeAgent, self.cdp)

    def test_failed_assertion_retains_the_exact_task_tab(self):
        with patch.object(bridge, "verify_checks", return_value=[{"kind": "text", "passed": False, "expected": "Saved", "actual": "Error"}]):
            result = bridge.execute_agent(self.request(), FakeAgent, self.cdp)
        self.assertEqual(result["status"], "failed")
        self.assertFalse(result["verified"])
        self.assertTrue(result["tabRetained"])
        self.assertFalse(FakeAgent.instance.browser.closed)
        bridge.require_target(result["targetId"], self.cdp)

    def test_success_closes_only_its_owned_tab_by_default(self):
        with patch.object(bridge, "verify_checks", return_value=[{"kind": "text", "passed": True, "expected": "Saved", "actual": "Saved"}]):
            result = bridge.execute_agent(self.request(), FakeAgent, self.cdp)
        self.assertEqual(result["status"], "passed")
        self.assertTrue(result["verified"])
        self.assertFalse(result["tabRetained"])
        self.assertTrue(FakeAgent.instance.browser.closed)
        self.assertFalse(bridge.target_file(result["targetId"]).exists())

    def test_browser_use_completion_is_explicitly_unverified(self):
        result = bridge.execute_agent(self.request(op="run"), FakeAgent, self.cdp)
        self.assertEqual(result["status"], "done")
        self.assertFalse(result["verified"])
        self.assertTrue(result["tabRetained"])

    def test_stale_browser_registry_is_rejected(self):
        bridge.register_target("task-123")
        with patch.dict(os.environ, {"FASTEST_E2E_BROWSER_ID": "different"}):
            with self.assertRaises(bridge.BridgeError):
                bridge.require_target("task-123", self.cdp)

    def test_unowned_tabs_and_path_traversal_are_rejected(self):
        for target in ["unowned", "../../personal"]:
            with self.assertRaises(bridge.BridgeError):
                bridge.require_target(target, self.cdp)

    def test_missing_endpoint_fails_before_harness_import(self):
        with patch.dict(os.environ, {"BU_CDP_WS": "", "BU_CDP_URL": "http://personal:9222"}):
            with self.assertRaises(bridge.BridgeError):
                bridge.verify_connection()

    def test_verification_requires_every_result(self):
        with self.assertRaises(bridge.BridgeError):
            bridge.verify_checks(self.cdp, "session", [{"kind": "text", "value": "Saved"}], 0)

    def test_browser_shutdown_also_retires_its_daemon(self):
        harness, admin = ModuleType("browser_harness"), ModuleType("browser_harness.admin")
        harness.helpers = Mock()
        admin.ensure_daemon, admin.restart_daemon = Mock(), Mock()
        admin.daemon_alive = Mock(return_value=False)
        with patch.dict(sys.modules, {"browser_harness": harness, "browser_harness.admin": admin}):
            with patch.object(bridge, "verify_connection", side_effect=[None, bridge.BridgeError("session", "closed")]):
                self.assertEqual(bridge.dispatch({"op": "stop"}), {"ok": True})
        harness.helpers.cdp.assert_called_once_with("Browser.close")
        admin.restart_daemon.assert_called_once_with()
        admin.daemon_alive.assert_called_once_with()

    def test_model_errors_do_not_leak_credentials_or_pass(self):
        class BrokenAgent(FakeAgent):
            def command(self, _):
                raise RuntimeError("secret-api-key")
        result = bridge.execute_agent(self.request(), BrokenAgent, self.cdp)
        self.assertEqual(result["status"], "blocked")
        self.assertNotIn("secret-api-key", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
