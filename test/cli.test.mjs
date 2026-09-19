import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const invoke = (args, env = {}) => spawnSync(process.execPath, ["dist/cli.js", ...args], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 10000 });
test("CLI help exposes the implemented commands", () => {
  const result = invoke(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  for (const word of ["run", "test", "mcp", "doctor", "harness"]) assert.ok(result.stdout.includes(word), result.stdout);
});
test("doctor never discovers personal Chrome and fails when unconfigured", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fe2e-doctor-"));
  try {
    const result = invoke(["doctor"], { FASTEST_E2E_HOME: root });
    const report = JSON.parse(result.stdout);
    assert.equal(report.configured, false); assert.equal(report.connected, false);
    assert.equal(result.status, 2, result.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("bad run input fails before any model or browser access", () => {
  const result = invoke(["run", "--url", "file:///etc/passwd", "Read it"]);
  assert.equal(JSON.parse(result.stdout).error.code, "input");
  assert.equal(result.status, 2, result.stderr);
});
