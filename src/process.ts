import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Effect } from "effect";
import { registerWorker } from "./host.js";
import { BrowserError } from "./contracts.js";

interface Running {
  child: ChildProcessWithoutNullStreams;
  result: Promise<string>;
  closed: Promise<void>;
}

// Spawn once per workflow, not once per click. Finalization waits for worker exit
// before the outer session lock can be released, including MCP cancellation.
export function subprocess(command: string, args: readonly string[], env: NodeJS.ProcessEnv, input: string, timeoutMs: number) {
  const launch = Effect.try({
    try: (): Running => {
      const child = spawn(command, [...args], { env, stdio: "pipe", windowsHide: true });
      if (child.pid && env.FASTEST_E2E_LEASE_FILES) {
        try { registerWorker(child.pid, env); } catch (e) { child.kill("SIGKILL"); throw e; }
      }
      const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
      const result = new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let reason: string | undefined;
        const timeout = setTimeout(() => { reason = "deadline"; child.kill("SIGTERM"); }, timeoutMs);
        const force = setTimeout(() => { reason = "deadline"; child.kill("SIGKILL"); }, timeoutMs + 1_000);
        child.stdin.on("error", () => { /* Early process exit is reported below. */ });
        child.stdout.on("data", (data: Buffer) => {
          size += data.length;
          if (size > 12_000_000) { reason = "output_limit"; child.kill("SIGKILL"); }
          else chunks.push(data);
        });
        child.stderr.resume(); // Never mix dependency/model logs into JSON or MCP stdout.
        child.once("error", () => { reason = "spawn"; });
        child.once("close", (code) => {
          clearTimeout(timeout); clearTimeout(force);
          if (reason || code !== 0) reject(new BrowserError({
            code: reason ?? "worker",
            reason: reason === "deadline"
              ? "Worker exceeded its deadline. The outcome may be partial; inspect before retrying."
              : "Worker could not complete. Check installation and session with fastest-e2e doctor. No action was retried.",
          }));
          else resolve(Buffer.concat(chunks).toString("utf8"));
        });
        child.stdin.end(input);
      });
      // The rejection is also consumed by Effect; prevent a cancellation race
      // from becoming an unhandled Promise rejection during finalization.
      void result.catch(() => undefined);
      return { child, result, closed };
    },
    catch: () => new BrowserError({ code: "spawn", reason: "Could not start the configured executable." }),
  });
  return Effect.acquireUseRelease(
    launch,
    ({ result }) => Effect.tryPromise({ try: () => result, catch: error => error instanceof BrowserError ? error : new BrowserError({ code: "worker", reason: "Worker failed." }) }),
    ({ child, closed }) => Effect.promise(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        const force = setTimeout(() => child.kill("SIGKILL"), 1_000);
        await closed;
        clearTimeout(force);
      } else await closed;
    }),
  );
}
