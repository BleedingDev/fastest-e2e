import { Runtime, Schema } from "effect";

export class BrowserError extends Schema.TaggedError<BrowserError>()("BrowserError", {
  code: Schema.String,
  reason: Schema.String,
}) {
  override readonly [Runtime.errorExitCode] = 2;
  override get message(): string { return `${this.code}: ${this.reason}`; }
}

export const Check = Schema.Struct({
  kind: Schema.Literals(["text", "url", "value", "checked", "count"]),
  value: Schema.String,
  selector: Schema.optional(Schema.String),
});
export type Check = typeof Check.Type;

export const RunInput = Schema.Struct({
  url: Schema.String,
  goal: Schema.String,
  maxSteps: Schema.optional(Schema.Int),
  timeoutMs: Schema.optional(Schema.Int),
  keepTab: Schema.optional(Schema.Boolean),
});
export type RunInput = typeof RunInput.Type;

export const TestInput = Schema.Struct({
  ...RunInput.fields,
  name: Schema.String,
  checks: Schema.Array(Check),
  checkTimeoutMs: Schema.optional(Schema.Int),
  changeRef: Schema.optional(Schema.String),
});
export type TestInput = typeof TestInput.Type;

export const TargetInput = Schema.Struct({ targetId: Schema.String });
export type TargetInput = typeof TargetInput.Type;

export const CheckResult = Schema.Struct({
  kind: Schema.String,
  passed: Schema.Boolean,
  expected: Schema.String,
  actual: Schema.String,
});
export const RunResult = Schema.Struct({
  name: Schema.optional(Schema.String),
  changeRef: Schema.optional(Schema.String),
  status: Schema.Literals(["done", "passed", "failed", "blocked"]),
  verified: Schema.Boolean,
  durationMs: Schema.Number,
  engineMs: Schema.Number,
  actions: Schema.Int,
  browserId: Schema.String,
  targetId: Schema.String,
  tabRetained: Schema.Boolean,
  finalUrl: Schema.String,
  checks: Schema.Array(CheckResult),
  reason: Schema.String,
});
export type RunResult = typeof RunResult.Type;

export const Inspection = Schema.Struct({
  browserId: Schema.String,
  targetId: Schema.String,
  url: Schema.String,
  title: Schema.String,
  text: Schema.String,
});
export const Acknowledgement = Schema.Struct({ ok: Schema.Boolean });

export function validateRun(input: RunInput): void {
  const url = new URL(input.url);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new BrowserError({ code: "input", reason: "Use an HTTP(S) URL without embedded credentials." });
  }
  if (!input.goal.trim() || input.goal.length > 20_000) {
    throw new BrowserError({ code: "input", reason: "Provide a goal between 1 and 20,000 characters." });
  }
  for (const [name, value, min, max] of [
    ["maxSteps", input.maxSteps ?? 30, 1, 100],
    ["timeoutMs", input.timeoutMs ?? 120_000, 1_000, 600_000],
  ] as const) {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new BrowserError({ code: "input", reason: `${name} must be an integer between ${min} and ${max}.` });
    }
  }
}

export function validateTest(input: TestInput): void {
  validateRun(input);
  if (!input.name.trim() || input.checks.length === 0 || input.checks.length > 50) {
    throw new BrowserError({ code: "input", reason: "A test needs a name and between 1 and 50 assertions." });
  }
  const timeout = input.checkTimeoutMs ?? 5_000;
  if (!Number.isInteger(timeout) || timeout < 0 || timeout > 30_000) {
    throw new BrowserError({ code: "input", reason: "checkTimeoutMs must be between 0 and 30,000." });
  }
  for (const check of input.checks) {
    if (["value", "checked", "count"].includes(check.kind) && !check.selector?.trim()) {
      throw new BrowserError({ code: "input", reason: `${check.kind} requires a CSS selector.` });
    }
    if (check.kind === "checked" && !["true", "false"].includes(check.value)) {
      throw new BrowserError({ code: "input", reason: "checked expects 'true' or 'false'." });
    }
    if (check.kind === "count" && !/^(0|[1-9][0-9]*)$/.test(check.value)) {
      throw new BrowserError({ code: "input", reason: "count expects a nonnegative integer string." });
    }
    if ((check.kind === "text" || check.kind === "url") && !check.value.trim()) {
      throw new BrowserError({ code: "input", reason: "text and url expectations cannot be empty." });
    }
  }
}

export const exitCode = (status: RunResult["status"]): number =>
  status === "failed" ? 1 : status === "blocked" ? 2 : 0;
