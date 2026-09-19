import * as fs from "node:fs/promises";
import path from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import { Acknowledgement, BrowserError, Inspection, RunInput, RunResult, TestInput, validateRun, validateTest } from "./contracts.js";
import * as host from "./host.js";
import { subprocess } from "./process.js";

export const io = <A>(operation: () => Promise<A>) => Effect.tryPromise({
  try: operation,
  catch: error => error instanceof BrowserError ? error : new BrowserError({ code: "runtime", reason: error instanceof Error ? error.message : "Operation failed." }),
});
const inputError = () => new BrowserError({ code: "input", reason: "Input does not match the command schema." });
const protocolError = () => new BrowserError({ code: "protocol", reason: "Worker returned an invalid response. No action was retried." });

const locked = <A, E, R>(work: () => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(io(host.acquireLock), work, release => Effect.promise(release));

const withSession = <A, E, R>(work: (session: host.Session) => Effect.Effect<A, E, R>) =>
  locked(() => io(host.connect).pipe(Effect.flatMap(work)));

function worker(session: host.Session, request: object, timeoutMs: number) {
  return subprocess(host.pythonExecutable(), [path.join(host.packageRoot, "worker/bridge.py")],
    host.workerEnvironment(session), JSON.stringify(request), timeoutMs).pipe(
    Effect.flatMap(text => Effect.try({
      try: (): unknown => {
        const envelope = JSON.parse(text) as { ok?: boolean; result?: unknown; error?: { code?: string; reason?: string } };
        if (!envelope.ok) throw new BrowserError({ code: envelope.error?.code ?? "worker", reason: envelope.error?.reason ?? "Worker failed." });
        return envelope.result;
      },
      catch: error => error instanceof BrowserError ? error : protocolError(),
    })),
  );
}

export const Doctor = Schema.Struct({
  configured: Schema.Boolean,
  workerInstalled: Schema.Boolean,
  connected: Schema.Boolean,
  browserId: Schema.String,
  jevKeyPresent: Schema.Boolean,
  textKeyPresent: Schema.Boolean,
  reason: Schema.String,
});
export const ScriptInput = Schema.Struct({ targetId: Schema.String, code: Schema.String });
export const ScriptResult = Schema.Struct({ browserId: Schema.String, targetId: Schema.String, output: Schema.String });

export class BrowserRuntime extends Context.Service<BrowserRuntime, {
  readonly run: (input: RunInput) => Effect.Effect<RunResult, BrowserError>;
  readonly test: (input: TestInput) => Effect.Effect<RunResult, BrowserError>;
  readonly inspect: (targetId: string) => Effect.Effect<typeof Inspection.Type, BrowserError>;
  readonly close: (targetId: string) => Effect.Effect<typeof Acknowledgement.Type, BrowserError>;
  readonly harness: (input: typeof ScriptInput.Type) => Effect.Effect<typeof ScriptResult.Type, BrowserError>;
  readonly doctor: Effect.Effect<typeof Doctor.Type, BrowserError>;
}>()("fastest-e2e/BrowserRuntime", {
  make: Effect.sync(() => {
    const execute = (input: RunInput | TestInput, testing: boolean) => Effect.gen(function* () {
      const started = performance.now();
      yield* Effect.try({ try: () => testing ? validateTest(input as TestInput) : validateRun(input), catch: inputError });
      if (!process.env.TYPESAFE_API_KEY) return yield* Effect.fail(new BrowserError({ code: "credentials", reason: "Set TYPESAFE_API_KEY in the invoking process environment." }));
      return yield* withSession(session => worker(session, { op: testing ? "test" : "run", ...input }, input.timeoutMs ?? 120_000).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(RunResult)),
        Effect.map(result => ({ ...result, durationMs: Math.round(performance.now() - started),
          ...(testing ? { name: (input as TestInput).name, ...((input as TestInput).changeRef ? { changeRef: (input as TestInput).changeRef } : {}) } : {}),
        })),
        Effect.mapError(error => error instanceof BrowserError ? error : protocolError()),
      ));
    });
    const run = (input: RunInput) => Schema.decodeUnknownEffect(RunInput)(input).pipe(
      Effect.mapError(inputError), Effect.flatMap(value => execute(value, false)));
    const test = (input: TestInput) => Schema.decodeUnknownEffect(TestInput)(input).pipe(
      Effect.mapError(inputError), Effect.flatMap(value => execute(value, true)));
    const inspect = (targetId: string) => withSession(session => worker(session, { op: "inspect", targetId }, 15_000).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Inspection)), Effect.mapError(error => error instanceof BrowserError ? error : protocolError())));
    const close = (targetId: string) => withSession(session => worker(session, { op: "close", targetId }, 15_000).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Acknowledgement)), Effect.mapError(error => error instanceof BrowserError ? error : protocolError())));
    const harness = (input: typeof ScriptInput.Type) => withSession(session => worker(session, { op: "harness", ...input }, 120_000).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ScriptResult)), Effect.mapError(error => error instanceof BrowserError ? error : protocolError())));
    const doctor = io(async () => {
      const configured = await host.configuration().then(() => true, () => false);
      const workerInstalled = await fs.access(host.pythonExecutable()).then(() => true, () => false);
      let session: host.Session | undefined;
      let reason = "";
      try { session = await host.connect(); } catch (error) { reason = error instanceof Error ? error.message : "No configured connection."; }
      return { configured, workerInstalled, connected: session !== undefined, browserId: session?.browserId ?? "",
        jevKeyPresent: Boolean(process.env.TYPESAFE_API_KEY), textKeyPresent: Boolean(process.env.TEXT_MODEL_API_KEY), reason };
    });
    return { run, test, inspect, close, harness, doctor };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

export const init = (chrome?: string, profile?: string) => locked(() => io(() => host.initialize(chrome, profile)));
export const start = (headed: boolean) => locked(() => io(() => host.startChrome(headed)).pipe(
  Effect.map(({ browserId, profileDir, reused }) => ({ browserId, profileDir, reused }))));
export const stop = withSession(session => worker(session, { op: "stop" }, 15_000));

export const install = locked(() => {
  const env: NodeJS.ProcessEnv = { ...process.env, UV_PROJECT_ENVIRONMENT: path.join(host.home(), "worker-venv") };
  delete env.TYPESAFE_API_KEY; delete env.TEXT_MODEL_API_KEY;
  return subprocess("uv", ["sync", "--project", path.join(host.packageRoot, "worker"), "--python", "3.12", "--no-dev", "--locked"],
    env, "", 180_000).pipe(Effect.as({ ok: true }));
});
