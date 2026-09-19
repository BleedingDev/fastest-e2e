"""One JSON request per process. Reuse upstream Jev; never reimplement its policy."""
from __future__ import annotations

import contextlib
import io
import json
import os
from pathlib import Path
import re
import signal
import sys
import time
from urllib.parse import urlsplit
import urllib.request


class BridgeError(Exception):
    def __init__(self, code: str, reason: str):
        super().__init__(reason)
        self.code = code
        self.reason = reason


class Cancelled(Exception):
    pass


def cancelled(_signum, _frame):
    raise Cancelled("The caller cancelled this task.")


def verify_connection() -> None:
    """Check again in the worker, before importing anything that can discover Chrome."""
    ws = os.environ.get("BU_CDP_WS", "")
    parsed = urlsplit(ws)
    if (parsed.scheme != "ws" or parsed.hostname != "127.0.0.1" or not parsed.port
            or not re.fullmatch(r"/devtools/browser/[a-zA-Z0-9-]+", parsed.path)
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or os.environ.get("BU_CDP_URL")):
        raise BridgeError("session", "An explicit loopback browser WebSocket is required; discovery is disabled.")
    if parsed.path.rsplit("/", 1)[-1] != os.environ.get("FASTEST_E2E_BROWSER_ID"):
        raise BridgeError("session", "Browser identity does not match this task.")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(f"http://127.0.0.1:{parsed.port}/json/version", timeout=2) as response:
            actual = json.load(response)["webSocketDebuggerUrl"]
        if actual != ws:
            raise ValueError("different browser")
    except Exception as error:
        raise BridgeError("session", "Configured Chrome changed or disconnected. No other browser was selected.") from error


def target_file(target: str) -> Path:
    if not re.fullmatch(r"[a-zA-Z0-9-]{1,128}", target):
        raise BridgeError("target", "Invalid target identifier.")
    directory = Path(os.environ["FASTEST_E2E_TARGET_DIR"])
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    return directory / f"{target}.json"


def register_target(target: str) -> None:
    p = target_file(target)
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump({"targetId": target, "browserId": os.environ["FASTEST_E2E_BROWSER_ID"]}, output)


def require_target(target: str, cdp) -> None:
    try:
        record = json.loads(target_file(target).read_text())
        if record != {"targetId": target, "browserId": os.environ["FASTEST_E2E_BROWSER_ID"]}:
            raise ValueError("different owner")
    except (OSError, ValueError) as error:
        raise BridgeError("target", "This tab is not owned by fastest-e2e in the current browser instance.") from error
    try:
        cdp("Target.getTargetInfo", targetId=target)
    except Exception as error:
        raise BridgeError("target", "The task tab is no longer open.") from error


def evaluate(cdp, session: str, expression: str):
    result = cdp("Runtime.evaluate", session_id=session, expression=expression, returnByValue=True)
    if result.get("exceptionDetails"):
        raise BridgeError("verification", "The page changed during inspection or the assertion could not be evaluated.")
    return result.get("result", {}).get("value")


# All assertion code is owned by this package. Selectors and expected values are
# JSON data. No generated JavaScript, application API calls, or state mutation.
CHECK_JS = r"""(checks => checks.map(c => {
  const result = {kind:c.kind, expected:c.value, actual:'', passed:false};
  let nodes;
  try { nodes = c.selector ? [...document.querySelectorAll(c.selector)] : [document.body]; }
  catch { return {...result, error:'Invalid CSS selector'}; }
  if (c.kind === 'url') result.actual = location.href;
  else if (c.kind === 'count') result.actual = String(nodes.length);
  else {
    if (nodes.length !== 1 || !nodes[0]) return {...result, actual:`<${nodes.length} matching elements>`};
    const e = nodes[0], r = e.getBoundingClientRect();
    if (!r.width || !r.height || !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))
      return {...result, actual:'<not visible>'};
    if (c.kind === 'text') result.actual = e.innerText || '';
    else if (c.kind === 'value') {
      if (e.type === 'password') return {...result, error:'Password values cannot be used as assertion evidence'};
      if (!('value' in e)) return {...result, error:'Target is not a value control'};
      result.actual = String(e.value);
    } else if (c.kind === 'checked') {
      if (typeof e.checked !== 'boolean') return {...result, error:'Target is not a checkable control'};
      result.actual = String(e.checked);
    } else return {...result, error:'Unknown assertion kind'};
  }
  result.passed = c.kind === 'text' ? result.actual.includes(c.value) : result.actual === c.value;
  result.actual = result.actual.slice(0, 2048);
  return result;
}))"""


def verify_checks(cdp, session: str, checks: list[dict], timeout_ms: int) -> list[dict]:
    if not checks:
        raise BridgeError("verification", "A test must have at least one assertion.")
    deadline = time.monotonic() + timeout_ms / 1000
    while True:
        results = evaluate(cdp, session, f"{CHECK_JS}({json.dumps(checks)})")
        if not isinstance(results, list) or len(results) != len(checks):
            raise BridgeError("verification", "The page did not return the complete assertion result.")
        if any(item.get("error") for item in results):
            raise BridgeError("verification", next(item["error"] for item in results if item.get("error")))
        if all(item.get("passed") is True for item in results) or time.monotonic() >= deadline:
            return results
        time.sleep(0.1)


def verdict(execution: str, checks: list[dict], testing: bool) -> str:
    if execution != "done":
        return "blocked"
    if not testing:
        return "done"
    if not checks:
        return "blocked"
    return "passed" if all(item.get("passed") is True for item in checks) else "failed"


def execute_agent(request: dict, agent_type, cdp) -> dict:
    testing = request["op"] == "test"
    if testing and not request.get("checks"):
        raise BridgeError("input", "Tests require explicit assertions.")
    if urlsplit(request["url"]).scheme not in {"http", "https"}:
        raise BridgeError("input", "Use an HTTP(S) URL.")
    started = time.perf_counter()
    agent = agent_type(request["url"], request["goal"], screenshots=False)
    target, session = agent.browser.target, agent.browser.session
    register_target(target)
    checks: list[dict] = []
    reason = ""
    retained = True
    try:
        while agent.state["status"] not in {"done", "blocked"}:
            if len(agent.state["history"]) >= request.get("maxSteps", 30):
                agent.state["status"] = "blocked"
                reason = "Action budget reached. Inspect the tab before retrying."
                break
            agent.command("tick")
        execution = agent.state["status"]
        if testing:
            checks = verify_checks(cdp, session, request["checks"], request.get("checkTimeoutMs", 5000))
        status = verdict(execution, checks, testing)
        if status == "done":
            reason = "Jev reported completion. No independent assertions were requested."
        elif status == "blocked" and not reason:
            reason = "Jev could not finish the task. Continue on the retained tab."
        elif status == "failed":
            reason = "At least one explicit assertion did not match the page."
    except Cancelled:
        status, reason = "blocked", "Task cancelled; the application may have changed. Inspect before retrying."
    except BridgeError as error:
        status, reason = "blocked", error.reason
    except Exception:
        # Model errors may include page data or request metadata. Do not emit
        # their raw exception text into reports or MCP responses.
        status, reason = "blocked", "Execution stopped unexpectedly. Inspect the retained task tab; no action was retried."
    try:
        final_url = evaluate(cdp, session, "location.href") or ""
    except Exception:
        final_url = ""
    if status in {"done", "passed"} and not request.get("keepTab", not testing):
        agent.close()
        target_file(target).unlink(missing_ok=True)
        retained = False
    with contextlib.suppress(Exception):
        cdp("Target.detachFromTarget", sessionId=session)
    return {
        "status": status, "verified": status == "passed", "durationMs": round((time.perf_counter() - started) * 1000),
        "engineMs": agent.state.get("elapsed_ms", 0), "actions": len(agent.state["history"]),
        "browserId": os.environ["FASTEST_E2E_BROWSER_ID"], "targetId": target, "tabRetained": retained,
        "finalUrl": final_url, "checks": checks, "reason": reason,
    }


def dispatch(request: dict) -> dict:
    verify_connection()
    from browser_harness.admin import ensure_daemon, restart_daemon, daemon_alive
    from browser_harness import helpers
    ensure_daemon()
    cdp = helpers.cdp
    op = request.get("op")
    if op in {"run", "test"}:
        from jev_ultrafast import Agent
        return execute_agent(request, Agent, cdp)
    if op == "stop":
        with contextlib.suppress(Exception):
            cdp("Browser.close")
        for _ in range(20):
            try:
                verify_connection()
            except BridgeError:
                # Chrome shutdown must also retire this browser generation's
                # daemon. The upstream function only stops it despite its name.
                restart_daemon()
                if daemon_alive():
                    raise BridgeError("session", "Chrome stopped, but its Browser Harness daemon is still running.")
                return {"ok": True}
            time.sleep(0.1)
        raise BridgeError("session", "Chrome has not confirmed shutdown.")
    target = request.get("targetId", "")
    require_target(target, cdp)
    if op == "close":
        cdp("Target.closeTarget", targetId=target)
        target_file(target).unlink(missing_ok=True)
        return {"ok": True}
    if op == "harness":
        code = request.get("code", "")
        if not isinstance(code, str) or not code.strip() or len(code) > 100_000:
            raise BridgeError("input", "Provide a trusted Python script under 100 KB.")
        helpers.switch_tab(target)
        output = io.StringIO()
        scope = {name: getattr(helpers, name) for name in dir(helpers) if not name.startswith("_")}
        scope["__name__"] = "__main__"
        with contextlib.redirect_stdout(output):
            exec(compile(code, "<trusted-browser-script>", "exec"), scope)
        return {"browserId": os.environ["FASTEST_E2E_BROWSER_ID"], "targetId": target, "output": output.getvalue()[:100_000]}
    if op != "inspect":
        raise BridgeError("input", "Unknown worker operation.")
    session = cdp("Target.attachToTarget", targetId=target, flatten=True)["sessionId"]
    try:
        value = evaluate(cdp, session, "({url:location.href,title:document.title,text:(document.body?.innerText||'').slice(0,40000)})")
        return {**value, "browserId": os.environ["FASTEST_E2E_BROWSER_ID"], "targetId": target}
    finally:
        with contextlib.suppress(Exception):
            cdp("Target.detachFromTarget", sessionId=session)


def main() -> None:
    signal.signal(signal.SIGTERM, cancelled)
    signal.signal(signal.SIGINT, cancelled)
    try:
        raw = sys.stdin.read(1_000_001)
        if len(raw) > 1_000_000:
            raise BridgeError("input", "Worker request is too large.")
        request = json.loads(raw)
        with contextlib.redirect_stdout(sys.stderr):
            result = dispatch(request)
        response = {"ok": True, "result": result}
    except BridgeError as error:
        response = {"ok": False, "error": {"code": error.code, "reason": error.reason}}
    except Cancelled:
        response = {"ok": False, "error": {"code": "cancelled", "reason": "Task cancelled. Inspect the browser before retrying."}}
    except Exception:
        response = {"ok": False, "error": {"code": "worker", "reason": "Worker failed. Check installation, model credentials, and the configured session."}}
    print(json.dumps(response, ensure_ascii=True))


if __name__ == "__main__":
    main()
