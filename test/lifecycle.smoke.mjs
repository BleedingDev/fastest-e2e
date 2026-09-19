// Run explicitly in CI. Uses real Chrome and the public CLI, without model keys.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = mkdtempSync(path.join(tmpdir(), "fastest-e2e-lifecycle-"));
const env = { ...process.env, FASTEST_E2E_HOME: root };
const cli = (...args) => {
  const result = spawnSync(process.execPath, ["dist/cli.js", ...args], { env, encoding: "utf8", timeout: 200_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stdout} ${result.stderr}`);
  return JSON.parse(result.stdout);
};
try {
  const config = cli("init");
  assert.equal(config.profileDir, path.join(root, "chrome"));
  assert.deepEqual(cli("init"), config);
  assert.deepEqual(cli("install"), { ok: true });
  const first = cli("start");
  assert.equal(first.reused, false);
  const again = cli("start");
  assert.equal(again.reused, true);
  assert.equal(again.browserId, first.browserId);
  const doctor = cli("doctor");
  assert.equal(doctor.connected, true);
  assert.equal(doctor.workerInstalled, true);
  assert.equal(doctor.browserId, first.browserId);
  const activePath = path.join(config.profileDir, "DevToolsActivePort");
  const active = readFileSync(activePath, "utf8");
  try {
    writeFileSync(activePath, active.replace(first.browserId, "another-browser"));
    const rejected = spawnSync(process.execPath, ["dist/cli.js", "doctor"], { env, encoding: "utf8", timeout: 10_000 });
    assert.equal(rejected.status, 2);
    assert.equal(JSON.parse(rejected.stdout).connected, false);
  } finally { writeFileSync(activePath, active); }
  assert.deepEqual(cli("stop"), { ok: true });
  // Chrome may close CDP just before releasing its profile lock.
  await new Promise(resolve => setTimeout(resolve, 500));
  const second = cli("start");
  assert.notEqual(second.browserId, first.browserId);
  assert.equal(second.profileDir, config.profileDir);
  assert.deepEqual(cli("stop"), { ok: true });
  console.log(JSON.stringify({ lifecycle: "passed", modelCalls: 0,
    checks: ["init", "locked worker install", "headless launch", "warm reuse", "doctor", "mismatched endpoint rejection", "shutdown", "restart"] }));
} finally {
  spawnSync(process.execPath, ["dist/cli.js", "stop"], { env, stdio: "ignore", timeout: 20_000 });
  rmSync(root, { recursive: true, force: true });
}
