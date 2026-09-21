"""Disposable Chrome for integration tests; wait for a verified CDP endpoint."""
from __future__ import annotations

from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import subprocess
import time
from typing import Callable, Iterator
import urllib.request


class EndpointMismatch(RuntimeError):
    pass


def read_endpoint(active: Path) -> tuple[int, str]:
    lines = active.read_text(encoding="utf-8").splitlines()
    if len(lines) != 2 or not re.fullmatch(r"[0-9]{1,5}", lines[0]):
        raise ValueError("Incomplete or invalid DevToolsActivePort")
    port = int(lines[0])
    if not 1 <= port <= 65535 or not re.fullmatch(r"/devtools/browser/[a-zA-Z0-9-]+", lines[1]):
        raise ValueError("Invalid DevToolsActivePort endpoint")
    return port, lines[1]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise EndpointMismatch("CDP metadata must not redirect")


def probe_endpoint(port: int, browser_path: str, timeout: float) -> None:
    # Never inherit a proxy or follow a response outside this disposable browser.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(f"http://127.0.0.1:{port}/json/version", timeout=timeout) as response:
        if response.status != 200:
            raise ValueError("CDP metadata is not ready")
        metadata = json.load(response)
    expected = f"ws://127.0.0.1:{port}{browser_path}"
    if not isinstance(metadata, dict) or metadata.get("webSocketDebuggerUrl") != expected:
        raise EndpointMismatch("CDP identity differs from this profile's DevToolsActivePort")


def wait_for_endpoint(
    browser: subprocess.Popen,
    active: Path,
    *,
    timeout: float = 30.0,
    probe: Callable[[int, str, float], None] = probe_endpoint,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> tuple[int, str]:
    if timeout <= 0:
        raise ValueError("Startup timeout must be positive")
    deadline = clock() + timeout
    last_error = "endpoint file not written"
    while clock() < deadline:
        if browser.poll() is not None:
            raise RuntimeError(f"Fixture Chrome exited before CDP readiness (exit {browser.returncode})")
        try:
            port, browser_path = read_endpoint(active)
            remaining = deadline - clock()
            if remaining <= 0:
                break
            probe(port, browser_path, min(0.5, remaining))
            # Do not accept a file swapped while the metadata request was in flight.
            if read_endpoint(active) != (port, browser_path):
                raise EndpointMismatch("Chrome endpoint changed during startup")
            if browser.poll() is not None:
                raise RuntimeError("Fixture Chrome exited during the readiness check")
            if clock() >= deadline:
                break
            return port, browser_path
        except EndpointMismatch:
            raise
        except (OSError, ValueError) as error:
            # The file may not exist yet, be partially written, or precede HTTP readiness.
            last_error = type(error).__name__
        sleep(min(0.05, max(0.0, deadline - clock())))
    raise TimeoutError(f"Fixture Chrome did not expose verified CDP within {timeout:g}s; last state: {last_error}")


def stop_process(browser: subprocess.Popen) -> None:
    if browser.poll() is not None:
        return
    try:
        browser.terminate()
    except ProcessLookupError:
        return
    try:
        browser.wait(timeout=5)
    except subprocess.TimeoutExpired:
        browser.kill()
        browser.wait(timeout=5)


@contextmanager
def chrome_fixture(executable: str, profile: Path, *, timeout: float = 30.0) -> Iterator[tuple[int, str]]:
    # Integration tests supply a fresh temporary directory; never remove a live profile.
    profile.mkdir(mode=0o700)
    flags = [executable, "--headless=new", "--remote-debugging-address=127.0.0.1",
             "--remote-debugging-port=0", f"--user-data-dir={profile}",
             "--no-first-run", "--no-default-browser-check", "about:blank"]
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        flags.insert(1, "--no-sandbox")  # Disposable test Chrome only; never the production launcher.
    log_path = profile.parent / "fixture-chrome.log"
    fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as log:
        browser = subprocess.Popen(flags, stdout=log, stderr=log)
        try:
            try:
                endpoint = wait_for_endpoint(browser, profile / "DevToolsActivePort", timeout=timeout)
            except Exception as error:
                log.flush()
                with log_path.open("rb") as diagnostic:
                    diagnostic.seek(max(0, log_path.stat().st_size - 4096))
                    tail = diagnostic.read().decode("utf-8", errors="replace")
                raise RuntimeError(f"{error}\nDisposable Chrome startup log:\n{tail}") from error
            yield endpoint
        finally:
            stop_process(browser)
