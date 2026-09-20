#!/usr/bin/env node
import * as fs from "node:fs/promises";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Cause, Console, Effect, Layer, Logger, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { BrowserError } from "./contracts.js";
import { BrowserRuntime, init, install, io, start, stop } from "./runtime.js";
import { Task, TestTask, Resume, InspectRun } from "./task.js";
import { closeRun, inspectRun, resumeRun, screenshotRun, verifyRun, withLease } from "./workflows.js";
import { prune } from "./journal.js";
import { proposeRecipe, approveRecipe, listRecipes, forgetRecipe } from "./recipes.js";
import { home } from "./host.js";
import { mcp } from "./mcp.js";

const emit = (value: unknown) => Console.log(JSON.stringify(value));
const optionalString = (name: string) => Flag.String(name).pipe(Flag.optional, Flag.map(Option.getOrUndefined));
const emitResult = (result: Record<string, unknown>) => emit(result).pipe(Effect.andThen(Effect.sync(() => {
  process.exitCode = result.status === "failed" || result.recheckPassed === false ? 1 : result.status === "blocked" ? 2 : 0;
})));
const read = (file: string) => io(async () => {
  if (file !== "-") return fs.readFile(file, "utf8");
  let text = ""; for await (const chunk of process.stdin) { text += String(chunk); if (text.length > 1_000_000) throw new Error("Input too large"); } return text;
});
const initCommand = Command.make("init", { chrome: optionalString("chrome"), profile: optionalString("profile") },
  ({ chrome, profile }) => init(chrome, profile).pipe(Effect.flatMap(emit)));
const installCommand = Command.make("install", {}, () => install.pipe(Effect.flatMap(emit)));
const startCommand = Command.make("start", { headed: Flag.Boolean("headed").pipe(Flag.withDefault(false)) },
  ({ headed }) => start(headed).pipe(Effect.flatMap(emit)));
const stopCommand = Command.make("stop", {}, () => stop.pipe(Effect.flatMap(emit)));
const doctorCommand = Command.make("doctor", {}, () => Effect.gen(function* () {
  const runtime = yield* BrowserRuntime; const result = yield* runtime.doctor; yield* emit(result);
  if (!result.configured || !result.workerInstalled || !result.connected) process.exitCode = 2;
}));
const runCommand = Command.make("run", {
  file: optionalString("file"), url: optionalString("url"), goal: Argument.String("goal").pipe(Argument.optional),
  engine: Flag.String("engine").pipe(Flag.withDefault("jev")), requestId: optionalString("request-id"),
  maxSteps: Flag.Int("max-steps").pipe(Flag.withDefault(30)), timeoutMs: Flag.Int("timeout-ms").pipe(Flag.withDefault(120_000)),
  keepTab: Flag.Boolean("keep-tab").pipe(Flag.withDefault(true)),
}, input => Effect.gen(function* () {
  const runtime = yield* BrowserRuntime;
  if (input.file && (input.url || Option.getOrUndefined(input.goal))) return yield* Effect.fail(new BrowserError({ code: "input", reason: "Use --file or URL and goal, not both." }));
  const { file: _file, goal: _goal, ...flags } = input;
  const raw = input.file ? JSON.parse(yield* read(input.file)) as unknown : { ...flags, goal: Option.getOrUndefined(input.goal) };
  const task = yield* Schema.decodeUnknownEffect(Task)(raw, { onExcessProperty: "error" });
  yield* emitResult(yield* runtime.run(task));
}));
const testCommand = Command.make("test", { file: Flag.String("file") }, ({ file }) => Effect.gen(function* () {
  const runtime = yield* BrowserRuntime;
  const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(TestTask))(yield* read(file), { onExcessProperty: "error" });
  yield* emitResult(yield* runtime.test(input));
}));
const target = { target: optionalString("target"), run: optionalString("run") };
const inspectCommand = Command.make("inspect", { ...target, view: Flag.String("view").pipe(Flag.withDefault("summary")),
  cursor: Flag.Int("cursor").pipe(Flag.withDefault(0)), limit: Flag.Int("limit").pipe(Flag.withDefault(20)), selector: optionalString("selector"), frames: optionalString("frames"), shadow: optionalString("shadow"),
}, input => Effect.gen(function* () {
  if (input.run && !input.target) { yield* emit(yield* inspectRun(yield* Schema.decodeUnknownEffect(InspectRun)({ runId: input.run, view: input.view, cursor: input.cursor, limit: input.limit, ...(input.selector ? { selector: input.selector } : {}), ...(input.frames ? { frames: JSON.parse(input.frames) } : {}), ...(input.shadow ? { shadow: input.shadow } : {}) }))); return; }
  if (!input.target || input.run) return yield* Effect.fail(new BrowserError({ code: "input", reason: "Supply exactly one of --run or --target." }));
  const runtime = yield* BrowserRuntime; yield* emit(yield* runtime.inspect(input.target));
}));
const closeCommand = Command.make("close", target, input => Effect.gen(function* () {
  if (input.run && !input.target) { yield* emit(yield* closeRun(input.run)); return; }
  if (!input.target || input.run) return yield* Effect.fail(new BrowserError({ code: "input", reason: "Supply exactly one of --run or --target." }));
  const runtime = yield* BrowserRuntime; yield* emit(yield* runtime.close(input.target));
}));
const resumeCommand = Command.make("resume", { run: Flag.String("run"), revision: Flag.Int("revision"),
  mode: Flag.String("mode").pipe(Flag.withDefault("resume")), engine: optionalString("engine"), remainingGoal: optionalString("remaining-goal"),
}, input => Effect.gen(function* () {
  const request = yield* Schema.decodeUnknownEffect(Resume)({ runId: input.run, expectedRevision: input.revision, mode: input.mode, ...(input.engine ? { engine: input.engine } : {}), ...(input.remainingGoal ? { remainingGoal: input.remainingGoal } : {}) });
  yield* emitResult(yield* resumeRun(request));
}));
const verifyCommand = Command.make("verify", { run: Flag.String("run") }, ({ run }) => verifyRun(run).pipe(Effect.flatMap(emitResult)));
const reconcileCommand = Command.make("reconcile", { run: Flag.String("run"), fromRun: optionalString("from-run") }, ({ run, fromRun }) => verifyRun(run, true, fromRun).pipe(Effect.flatMap(emitResult)));
const screenshotCommand = Command.make("screenshot", { run: Flag.String("run"), fullPage: Flag.Boolean("full-page").pipe(Flag.withDefault(false)) },
  ({ run, fullPage }) => screenshotRun({ runId: run, fullPage }).pipe(Effect.flatMap(emit)));
const pruneCommand = Command.make("prune", {}, () => withLease(() => io(async () => ({ removed: prune(home()) }))).pipe(Effect.flatMap(emit)));
const harnessCommand = Command.make("harness", { target: Flag.String("target"), file: Flag.String("file") }, ({ target, file }) => Effect.gen(function* () {
  const runtime = yield* BrowserRuntime; const code = yield* read(file); yield* emit(yield* runtime.harness({ targetId: target, code }));
}));
const recipeCommand = Command.make("recipe").pipe(Command.withSubcommands([
  Command.make("list", {}, () => io(async () => ({ recipes: listRecipes(home()) })).pipe(Effect.flatMap(emit))),
  Command.make("propose", { run: Flag.String("run"), name: Flag.String("name") }, ({ run, name }) => withLease(() => io(async () => proposeRecipe(home(), run, name))).pipe(Effect.flatMap(emit))),
  Command.make("approve", { name: Flag.String("name"), trial: Flag.String("trial") }, ({ name, trial }) => withLease(() => io(async () => approveRecipe(home(), name, trial))).pipe(Effect.flatMap(emit))),
  Command.make("forget", { name: Flag.String("name") }, ({ name }) => withLease(() => io(async () => { forgetRecipe(home(), name); return { ok: true }; })).pipe(Effect.flatMap(emit))),
]));
const mcpCommand = Command.make("mcp", { allowScripts: Flag.Boolean("allow-scripts").pipe(Flag.withDefault(false)) },
  ({ allowScripts }) => Layer.launch(mcp(allowScripts)));
export const command = Command.make("fastest-e2e").pipe(
  Command.withDescription("Browser tasks and UI tests in an explicitly configured Chrome session. Commands emit JSON."),
  Command.withSubcommands([initCommand, installCommand, startCommand, stopCommand, doctorCommand, runCommand, testCommand, inspectCommand, closeCommand,
    resumeCommand, verifyCommand, reconcileCommand, screenshotCommand, pruneCommand, recipeCommand, harnessCommand, mcpCommand]),
);
NodeRuntime.runMain(Command.runWith(command, { version: "0.2.0" })(process.argv.slice(2)).pipe(
  Effect.catchTag("BrowserError", error => emit({ error: { code: error.code, reason: error.reason } }).pipe(Effect.andThen(Effect.sync(() => { process.exitCode = 2; })))),
  Effect.catchCause(() => emit({ error: { code: "input_or_runtime", reason: "Command could not complete. Check input with --help; inspect any existing run before retrying." } }).pipe(Effect.andThen(Effect.sync(() => { process.exitCode = 2; })))),
  Effect.provideService(Logger.LogToStderr, true),
  Effect.provide(Layer.provideMerge(BrowserRuntime.layer, NodeServices.layer)),
));
