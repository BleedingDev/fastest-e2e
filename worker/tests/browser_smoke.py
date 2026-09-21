"""Real Chrome and upstream Jev, with scripted model decisions. No paid API calls."""
import contextlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import re
import urllib.request
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bridge

HTML = b'''<!doctype html><title>Runtime fixture</title><label for="name">Display name</label>
<input id="name"><button id="save">Save</button><p id="result"></p><script>
nameInput=document.getElementById('name');nameInput.value=localStorage.getItem('name')||'';
document.getElementById('save').onclick=()=>{localStorage.setItem('name',nameInput.value);document.getElementById('result').textContent='Saved: '+nameInput.value};
</script>'''


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(HTML)

    def log_message(self, *_):
        pass


def choose(page, _goal, history):
    kind = "fill" if not history else "click" if len(history) == 1 else None
    action = next((a for a in page["actions"] if a["kind"] == kind
                   and (kind != "click" or "Save" in a["label"])), None) if kind else None
    if kind and action is None:
        raise AssertionError(f"Fixture action {kind!r} was not observed: {page['actions']}")
    choice = action["id"] if action else "DONE"
    return {"choice": choice, "probabilities": {choice: 1.0}, "confidence": 1.0, "latency_ms": 0,
            "operation": kind or "DONE", "target": choice, "usage": {}}


def wait_for_browser(browser, profile, log_path=None, timeout=30):
    """Wait for complete endpoint metadata, not just the existence of its file."""
    deadline = time.monotonic() + timeout
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    reason = "Chrome did not expose a ready CDP endpoint before the deadline"
    while time.monotonic() < deadline:
        if browser.poll() is not None:
            reason = f"Chrome exited before CDP readiness (exit {browser.returncode})"
            break
        try:
            lines = (profile / "DevToolsActivePort").read_text().strip().splitlines()
            port, browser_path = int(lines[0]), lines[1]
            if not 1 <= port <= 65535 or not re.fullmatch(r"/devtools/browser/[a-zA-Z0-9-]+", browser_path):
                raise ValueError("incomplete or invalid endpoint")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            with opener.open(f"http://127.0.0.1:{port}/json/version", timeout=min(1, remaining)) as response:
                actual = json.load(response).get("webSocketDebuggerUrl")
            if actual == f"ws://127.0.0.1:{port}{browser_path}":
                return str(port), browser_path
        except (OSError, ValueError, IndexError):
            pass  # Chrome can create the file before writing both lines or serving CDP.
        time.sleep(min(.05, max(0, deadline - time.monotonic())))
    diagnostic = log_path.read_text(errors="replace")[-4096:] if log_path and log_path.exists() else ""
    raise RuntimeError(f"Fixture browser readiness failed: {reason}\n{diagnostic}")


def main():
    chrome = os.environ.get("CHROME_PATH") or shutil.which("google-chrome") or shutil.which("chromium")
    if not chrome:
        raise RuntimeError("Real-browser smoke test requires Chrome; this is not a skipped test.")
    with tempfile.TemporaryDirectory(prefix="fe2e-browser-") as temp:
        root = Path(temp)
        profile = root / "profile"
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        flags = [chrome, "--headless=new", "--remote-debugging-port=0", f"--user-data-dir={profile}", "--no-first-run", "about:blank"]
        # Only this disposable CI fixture may disable Chrome's sandbox when run
        # as root. The production launcher never adds this flag.
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
                "BU_CDP_WS": f"ws://127.0.0.1:{port}{browser_path}", "BU_NAME": "fe2e-smoke",
                "BH_HOME": str(root / "harness"), "BROWSER_HARNESS_HOME": str(root / "harness"),
                "BH_RECORD": "0", "BH_TAB_MARKER": "0", "BH_DOMAIN_SKILLS": "0",
                "FASTEST_E2E_BROWSER_ID": browser_path.rsplit("/", 1)[-1],
                "FASTEST_E2E_TARGET_DIR": str(root / "targets"),
            })
            url = f"http://127.0.0.1:{server.server_port}/"
            scenario = {"op": "test", "url": url, "goal": "Set display name to CI value and save", "keepTab": True,
                        "checkTimeoutMs": 1000, "checks": [{"kind": "text", "selector": "#result", "value": "Saved: CI value"}]}
            from jev_ultrafast import agent
            with patch.object(agent, "choose", choose), patch.object(agent, "field_text", return_value=("CI value", {"model": "fixture", "latency_ms": 0})):
                result = bridge.dispatch(scenario)
            assert result["status"] == "passed", result
            target = result["targetId"]
            inspected = bridge.dispatch({"op": "inspect", "targetId": target})
            assert inspected["targetId"] == target
            assert "Saved: CI value" in inspected["text"]
            script_result = bridge.dispatch({"op": "harness", "targetId": target,
                "code": "cdp('Page.reload')\nwait_for_load()\nprint(js(\"document.getElementById('name').value\"))"})
            assert "CI value" in script_result["output"], script_result
            # A wrong browser ID must fail before Browser Harness can reconnect.
            actual_id = os.environ["FASTEST_E2E_BROWSER_ID"]
            os.environ["FASTEST_E2E_BROWSER_ID"] = "wrong-browser"
            try:
                bridge.dispatch({"op": "inspect", "targetId": target})
                raise AssertionError("Different browser identity was accepted")
            except bridge.BridgeError:
                pass
            finally:
                os.environ["FASTEST_E2E_BROWSER_ID"] = actual_id
            assert bridge.dispatch({"op": "close", "targetId": target}) == {"ok": True}
            print(json.dumps({"realChrome": True, "upstreamJev": True, "modelCalls": 0,
                              "checks": ["UI input", "UI save", "fresh assertions", "same-tab fallback", "reload persistence", "browser identity", "owned-tab cleanup"]}))
        finally:
            with contextlib.suppress(Exception):
                from browser_harness.admin import restart_daemon
                restart_daemon()
            browser.terminate()
            try:
                browser.wait(timeout=5)
            except subprocess.TimeoutExpired:
                browser.kill()
                browser.wait()
            browser_log.close()
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    main()
