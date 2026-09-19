import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { subprocess } from "../dist/process.js";

test("worker input stays on stdin and stderr never contaminates JSON", async () => {
  const code = `let data='';process.stdin.on('data',x=>data+=x);process.stdin.on('end',()=>{console.error('private');console.log(data)})`;
  const output = await Effect.runPromise(subprocess(process.execPath, ["-e", code], process.env, '{"goal":"hello"}', 5000));
  assert.deepEqual(JSON.parse(output), { goal: "hello" });
});
test("worker deadline terminates an unresponsive child", async () => {
  await assert.rejects(Effect.runPromise(subprocess(process.execPath, ["-e", "setInterval(()=>{},1000)"], process.env, "", 50)), /deadline/);
});
test("missing executable produces a typed failure", async () => {
  await assert.rejects(Effect.runPromise(subprocess("/does/not/exist", [], process.env, "", 1000)), /spawn/);
});
test("cancellation waits for child termination", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fe2e-process-"));
  const pidFile = path.join(dir, "pid");
  const controller = new AbortController();
  const childCode = `require('node:fs').writeFileSync(process.argv[1], String(process.pid));setInterval(()=>{},1000)`;
  const running = Effect.runPromise(subprocess(process.execPath, ["-e", childCode, pidFile], process.env, "", 10000), { signal: controller.signal });
  void running.catch(() => undefined);
  try {
    let pid;
    for (let i = 0; i < 100; i++) {
      try { pid = Number(await readFile(pidFile, "utf8")); break; } catch { await new Promise(r => setTimeout(r, 10)); }
    }
    assert.ok(pid);
    controller.abort();
    await assert.rejects(running);
    assert.throws(() => process.kill(pid, 0));
  } finally { controller.abort(); await rm(dir, { recursive: true, force: true }); }
});
