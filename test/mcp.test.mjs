import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

test("MCP negotiates stdio and lists high-level tools without script execution by default", { timeout: 15000 }, async () => {
  const child = spawn(process.execPath, ["dist/cli.js", "mcp"], { stdio: "pipe" });
  let diagnostics = "";
  child.stderr.on("data", chunk => { diagnostics += chunk; });
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    let response;
    try { response = JSON.parse(line); } catch { assert.fail(`Non-JSON MCP stdout: ${line}`); }
    if (pending.has(response.id)) { pending.get(response.id)(response); pending.delete(response.id); }
  });
  let nextId = 0;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${diagnostics}`)); }, 5000);
    pending.set(id, response => { clearTimeout(timer); resolve(response); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  try {
    const initialized = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fastest-e2e-test", version: "1" } });
    assert.ok(initialized.result, JSON.stringify(initialized));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const listed = await request("tools/list", {});
    assert.deepEqual(listed.result.tools.map(tool => tool.name).sort(), ["browser_close", "browser_doctor", "browser_inspect", "browser_run", "browser_test"]);
    const result = await request("tools/call", { name: "browser_doctor", arguments: {} });
    assert.ok(result.result, JSON.stringify(result));
  } finally {
    child.kill("SIGTERM");
    await new Promise(resolve => child.once("close", resolve));
    lines.close();
  }
});
