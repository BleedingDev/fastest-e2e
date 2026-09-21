"""Managed same-tab Jev with actual upstream loop and controlled model decisions."""
import contextlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from http.server import ThreadingHTTPServer
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bridge
import jev_runner
from browser_smoke import Handler, choose, wait_for_browser


def main():
    chrome = os.environ.get("CHROME_PATH") or shutil.which("google-chrome") or shutil.which("chromium")
    if not chrome:
        raise RuntimeError("Chrome is required; this test must not silently skip")
    with tempfile.TemporaryDirectory(prefix="fe2e-managed-") as temp:
        root = Path(temp)
        profile = root / "profile"
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        flags = [chrome, "--headless=new", "--remote-debugging-port=0", f"--user-data-dir={profile}", "--no-first-run", "about:blank"]
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            flags.insert(1, "--no-sandbox")
        log_path = root / "chrome.log"
        browser_log = log_path.open("w")
        browser = subprocess.Popen(flags, stdout=subprocess.DEVNULL, stderr=browser_log)
        try:
            port, browser_path = wait_for_browser(browser, profile, log_path)
            for key in list(os.environ):
                if key.startswith(("BU_", "BH_", "BROWSER_HARNESS", "BROWSER_USE")):
                    del os.environ[key]
            os.environ.update({
                "BU_CDP_WS": f"ws://127.0.0.1:{port}{browser_path}", "BU_NAME": "managed-smoke",
                "BH_HOME": str(root / "harness"), "BROWSER_HARNESS_HOME": str(root / "harness"),
                "BH_RECORD": "0", "BH_TAB_MARKER": "0", "BH_DOMAIN_SKILLS": "0",
                "FASTEST_E2E_BROWSER_ID": browser_path.rsplit("/", 1)[-1],
                "FASTEST_E2E_TARGET_DIR": str(root / "targets"),
            })
            from jev_ultrafast import agent
            from jev_ultrafast.browser import Browser, StalePage
            from browser_harness.helpers import cdp
            page = Browser(f"http://127.0.0.1:{server.server_port}/")
            bridge.register_target(page.target)
            def make_run(**extra):
                run_id = "r_" + uuid.uuid4().hex
                directory = root / "runs" / run_id
                directory.mkdir(parents=True)
                (directory / "task.json").write_text(json.dumps({
                    "version": 2, "runId": run_id, "createdAt": round(time.time()*1000), "expiresAt": round(time.time()*1000)+100_000,
                    "profileDir": str(profile), "testing": False, "digest": "fixture",
                    "task": {"url": f"http://127.0.0.1:{server.server_port}/", "goal": "Save CI value", "recovery": {"fields": [{"key": "name", "selector": "#name"}]}, **extra},
                }))
                (directory / "events.jsonl").write_text("")
                journal = jev_runner.Journal(str(root), run_id)
                journal.append("target", targetId=page.target, browserId=os.environ["FASTEST_E2E_BROWSER_ID"])
                return journal, {"root": str(root), "runId": run_id, "targetId": page.target, "goal": "Set display name to CI value and save"}
            journal, request = make_run()
            with patch.object(agent, "choose", choose), patch.object(agent, "field_text", return_value=("CI value", {"model": "fixture", "latency_ms": 0})):
                result = jev_runner.execute(request)
            assert result["execution"] == "done", result
            assert "Saved: CI value" in bridge.dispatch({"op": "inspect", "targetId": page.target})["text"]
            events = journal.events()
            assert sum(e["type"] == "action.start" for e in events) == 2
            assert sum(e["type"] == "action.end" for e in events) == 2
            assert sum(e["type"] == "call.start" for e in events) == 4
            assert json.loads((journal.directory / "recovery.json").read_text())["name"]["value"] == "CI value"
            # Cross-language checkpoint identity: Python producer / TypeScript consumer.
            script = """import {Cdp, checkpoint} from './dist/cdp.js';
const s=JSON.parse(process.argv[1]); const c=await Cdp.open(s);try{console.log(JSON.stringify(await checkpoint(c,await c.attach(process.argv[2]))))}finally{await c.close()}
"""
            session = dict(wsUrl=os.environ["BU_CDP_WS"], browserId=os.environ["FASTEST_E2E_BROWSER_ID"], namespace="fixture", profileDir=str(profile))
            observed = json.loads(subprocess.check_output(["node", "--input-type=module", "-e", script, json.dumps(session), page.target], text=True))
            saved = next(e["data"] for e in reversed(events) if e["type"] == "checkpoint")
            assert observed["documentId"] == saved["documentId"], (observed, saved)
            assert observed["fingerprint"] == saved["fingerprint"], (observed, saved)
            # Saved v0.2.0 tasks and selector aliases must not bypass capture protection.
            secret = "managed-secret-sentinel"
            page.evaluate("document.querySelector('#name').value=" + json.dumps(secret))
            for location in ("steps", "reconstruct"):
                protected_step = {"kind": "fill", "selector": "input", "valueFromEnv": "PRIVATE_INPUT"}
                recovery = {"fields": [{"key": "name", "selector": "#name"}]}
                extra = {"steps": [protected_step]} if location == "steps" else {}
                if location == "reconstruct": recovery["reconstruct"] = [protected_step]
                protected_journal, _ = make_run(recovery=recovery, **extra)
                try: jev_runner.capture(page, protected_journal)
                except bridge.BridgeError as error: assert error.code == "retention_forbidden", error.code
                else: raise AssertionError("Environment-backed selector alias was captured")
                assert not (protected_journal.directory / "recovery.json").exists()
                assert secret not in protected_journal.file.read_text()
            page.evaluate("document.querySelector('#name').value='CI value'")
            # Upstream retries StalePage, but the wrapper must never retry it after dispatch.
            second, req = make_run()
            original_act = Browser.act
            def interrupted_act(self, *args, **kwargs):
                original_act(self, *args, **kwargs)
                raise StalePage("Synthetic lost post-dispatch receipt")
            def choose_save(page, _goal, _history):
                action = next(a for a in page["actions"] if a["kind"] == "click" and "Save" in a["label"])
                return {"choice": action["id"], "probabilities": {action["id"]: 1}, "confidence": 1, "latency_ms": 0, "operation": "click", "target": action["id"], "usage": {}}
            with patch.object(agent, "choose", choose_save) as selection, patch.object(Browser, "act", interrupted_act):
                try: jev_runner.execute(req)
                except bridge.BridgeError as error: assert error.code == "mutation_uncertain", error.code
                else: raise AssertionError("Interrupted dispatch unexpectedly completed")
            assert sum(e["type"] == "action.start" for e in second.events()) == 1
            assert not any(e["type"] == "action.end" for e in second.events())
            empty, req = make_run(maxModelCalls=0)
            with patch.object(agent, "choose", side_effect=AssertionError("Model must not be called")):
                try: jev_runner.execute(req)
                except bridge.BridgeError as error: assert error.code == "budget_exhausted", error.code
                else: raise AssertionError("Call budget ignored")
            page.close()
            print(json.dumps({"suite": "managed Jev", "paidModelCalls": 0, "checks": ["actual upstream loop", "same owned tab", "durable dispatch receipts", "allowlisted fields", "cross-language checkpoints", "no post-dispatch stale retry", "shared call budget", "environment-backed capture aliases rejected"]}))
        finally:
            with contextlib.suppress(Exception):
                from browser_harness.admin import restart_daemon
                restart_daemon()
            browser.terminate()
            try: browser.wait(timeout=5)
            except subprocess.TimeoutExpired: browser.kill(); browser.wait()
            browser_log.close()
            server.shutdown(); server.server_close()


if __name__ == "__main__": main()
