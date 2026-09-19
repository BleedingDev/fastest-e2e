#!/usr/bin/env node
import * as fs from "node:fs/promises";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Layer, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { BrowserError, exitCode, TestInput } from "./contracts.js";
import { BrowserRuntime, init, install, io, start, stop } from "./runtime.js";
import { mcp } from "./mcp.js";

const emit = (value: unknown) => Console.log(JSON.stringify(value));
const optionalString = (name: string) => Flag.String(name).pipe(Flag.optional, Flag.map(Option.getOrUndefined));
const initCommand = Command.make("init", { chrome: optionalString("chrome"), profile: optionalString("profile") },
  ({ chrome, profile }) => init(chrome, profile).pipe(Effect.flatMap(emit)));
const installCommand = Command.make("install", {}, () => install.pipe(Effect.flatMap(emit)));
const startCommand = Command.make("start", { headed: Flag.Boolean("headed").pipe(Flag.withDefault(false)) },
  ({ headed }) => start(headed).pipe(Effect.flatMap(emit)));
const stopCommand = Command.make("stop", {}, () => stop.pipe(Effect.flatMap(emit)));
const doctorCommand = Command.make("doctor", {}, () => Effect.gen(function* () {
  const runtime = yield* BrowserRuntime;
  const result = yield* runtime.doctor;
  yield* emit(result);
  if (!result.configured || !result.workerInstalled || !result.connected) process.exitCode = 2;
}));
const runCommand = Command.make("run", {
  url: Flag.String("url"), goal: Argument.String("goal"),
  maxSteps: Flag.Int("max-steps").pipe(Flag.withDefault(30)),
  timeoutMs: Flag.Int("timeout-ms").pipe(Flag.withDefault(120_000)),
  keepTab: Flag.Boolean("keep-tab").pipe(Flag.withDefault(true)),
}, input => Effect.gen(function* () {
  const runtime = yield* BrowserRuntime;
  const result = yield* runtime.run(input);
  yield* emit(result);
  process.exitCode = exitCode(result.status);
}));
const testCommand = Command.make("test", { file: Flag.String("file") }, ({ file }) => Effect.gen(function* () {
  const runtime = yield* BrowserRuntime;
  const text = yield* io(() => fs.readFile(file, "utf8"));
  const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(TestInput))(text).pipe(
    Effect.mapError(() => new BrowserError({ code: "input", reason: "Test file is not a valid scenario. See examples/settings.test.json." })));
  const result = yield* runtime.test(input);
  yield* emit(result);
  process.exitCode = exitCode(result.status);
}));
const inspectCommand = Command.make("inspect", { target: Flag.String("target") }, ({ target }) =>
  Effect.gen(function* () { const runtime = yield* BrowserRuntime; yield* emit(yield* runtime.inspect(target)); }));
const closeCommand = Command.make("close", { target: Flag.String("target") }, ({ target }) =>
  Effect.gen(function* () { const runtime = yield* BrowserRuntime; yield* emit(yield* runtime.close(target)); }));
const harnessCommand = Command.make("harness", { target: Flag.String("target"), file: Flag.String("file") }, ({ target, file }) =>
  Effect.gen(function* () {
    const runtime = yield* BrowserRuntime;
    const code = yield* io(() => fs.readFile(file, "utf8"));
    yield* emit(yield* runtime.harness({ targetId: target, code }));
  }));
const mcpCommand = Command.make("mcp", { allowScripts: Flag.Boolean("allow-scripts").pipe(Flag.withDefault(false)) },
  ({ allowScripts }) => Layer.launch(mcp(allowScripts)));

export const command = Command.make("fastest-e2e").pipe(
  Command.withDescription("Browser tasks and UI tests in an explicitly configured Chrome session. Commands emit JSON."),
  Command.withSubcommands([initCommand, installCommand, startCommand, stopCommand, doctorCommand, runCommand, testCommand, inspectCommand, closeCommand, harnessCommand, mcpCommand]),
);

NodeRuntime.runMain(Command.runWith(command, { version: "0.1.0" })(process.argv.slice(2)).pipe(
  Effect.catchTag("BrowserError", error => emit({ error: { code: error.code, reason: error.reason } }).pipe(
    Effect.andThen(Effect.sync(() => { process.exitCode = 2; })))),
  Effect.provide(Layer.provideMerge(BrowserRuntime.layer, NodeServices.layer)),
));
