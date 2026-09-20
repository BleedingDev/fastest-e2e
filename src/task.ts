import { Schema } from "effect";
import { Check, RunInput, TestInput, BrowserError, validateRun, validateTest } from "./contracts.js";

export const Engine = Schema.Literals(["auto", "jev", "vision"]);
export const Scope = { frames: Schema.optional(Schema.Array(Schema.String)), shadow: Schema.optional(Schema.Literals(["none", "open", "closed"])) };
export const Step = Schema.Struct({
  id: Schema.optional(Schema.String),
  kind: Schema.Literals(["navigate", "click", "fill", "press", "select", "check", "scroll", "goal", "checkpoint"]),
  selector: Schema.optional(Schema.String), value: Schema.optional(Schema.String),
  valueFromEnv: Schema.optional(Schema.String), valueFromInput: Schema.optional(Schema.String), valueFromRecovery: Schema.optional(Schema.String),
  goal: Schema.optional(Schema.String), engine: Schema.optional(Engine),
  safeToRepeat: Schema.optional(Schema.Boolean), checks: Schema.optional(Schema.Array(Check)), ...Scope,
});
export type Step = typeof Step.Type;
export const Extraction = Schema.Struct({
  name: Schema.String, kind: Schema.Literals(["text", "value", "url", "title", "attribute", "visual"]),
  selector: Schema.optional(Schema.String), attribute: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String), schema: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)), ...Scope,
});
export type Extraction = typeof Extraction.Type;
export const Recovery = Schema.Struct({
  restartSafe: Schema.optional(Schema.Boolean), maxAttempts: Schema.optional(Schema.Int),
  reconstruct: Schema.optional(Schema.Array(Step)),
  fields: Schema.optional(Schema.Array(Schema.Struct({ key: Schema.String, selector: Schema.String, ...Scope }))),
  reconcile: Schema.optional(Schema.Array(Check)),
  reconcileOutcome: Schema.optional(Schema.Literals(["completed", "not_applied"])),
});
const additions = {
  engine: Schema.optional(Engine), requestId: Schema.optional(Schema.String),
  steps: Schema.optional(Schema.Array(Step)), extract: Schema.optional(Schema.Array(Extraction)),
  recovery: Schema.optional(Recovery), maxModelCalls: Schema.optional(Schema.Int),
  retentionHours: Schema.optional(Schema.Int), preconditions: Schema.optional(Schema.Array(Check)),
  recipe: Schema.optional(Schema.String), inputs: Schema.optional(Schema.Record(Schema.String, Schema.String)),
};
export const Task = Schema.Struct({ ...RunInput.fields, ...additions });
export const TestTask = Schema.Struct({ ...TestInput.fields, ...additions });
export type Task = typeof Task.Type & { name?: string | undefined; checks?: readonly Check[] | undefined; changeRef?: string | undefined; checkTimeoutMs?: number | undefined };
export const Resume = Schema.Struct({
  runId: Schema.String, expectedRevision: Schema.Int,
  mode: Schema.optional(Schema.Literals(["resume", "reconstruct", "restart"])), engine: Schema.optional(Engine),
  remainingGoal: Schema.optional(Schema.String),
});
export type Resume = typeof Resume.Type;
export const RunRef = Schema.Struct({ runId: Schema.String });
export const ReconcileInput = Schema.Struct({ runId: Schema.String, fromRun: Schema.optional(Schema.String) });
export const InspectRun = Schema.Struct({ runId: Schema.String,
  view: Schema.optional(Schema.Literals(["summary", "page", "history", "checks", "task"])),
  cursor: Schema.optional(Schema.Int), limit: Schema.optional(Schema.Int), selector: Schema.optional(Schema.String), ...Scope,
});
export const ShotInput = Schema.Struct({ runId: Schema.String, fullPage: Schema.optional(Schema.Boolean) });
export const ReportSchema = Schema.Record(Schema.String, Schema.Unknown);
export type Report = Record<string, unknown>;

const invalid = (reason: string): never => { throw new BrowserError({ code: "input", reason }); };
export function validateTask(task: Task, testing: boolean): void {
  validateRun(task);
  if (testing) validateTest(task as typeof TestInput.Type);
  for (const [label, n, low, high] of [
    ["maxModelCalls", task.maxModelCalls ?? 60, 0, 200], ["retentionHours", task.retentionHours ?? 24, 1, 168],
  ] as const) if (!Number.isInteger(n) || n < low || n > high) invalid(`${label} must be ${low}..${high}.`);
  if (task.requestId && !/^[a-zA-Z0-9_.:-]{1,128}$/.test(task.requestId)) invalid("Invalid requestId.");
  if ((task.steps?.length ?? 0) > 100 || (task.extract?.length ?? 0) > 30) invalid("Too many steps or extraction fields.");
  const scope = (s: { frames?: readonly string[] | undefined; shadow?: string | undefined }) => {
    if ((s.frames?.length ?? 0) > 8 || s.frames?.some(f => !f.trim())) invalid("Frame paths must contain 1..8 nonempty CSS selectors.");
  };
  for (const c of [...(task.checks ?? []), ...(task.preconditions ?? []), ...(task.recovery?.reconcile ?? [])]) scope(c);
  const names = new Set<string>();
  for (const x of task.extract ?? []) {
    scope(x);
    if (!/^[a-zA-Z][\w-]{0,63}$/.test(x.name) || names.has(x.name)) invalid("Extraction names must be unique identifiers.");
    names.add(x.name);
    if (["value", "attribute"].includes(x.kind) && !x.selector) invalid(`${x.kind} extraction requires selector.`);
    if (x.kind === "attribute" && !x.attribute) invalid("attribute extraction requires attribute.");
    if (x.kind === "visual" && !x.prompt) invalid("Visual extraction requires prompt.");
    if (x.schema && JSON.stringify(x.schema).length > 20_000) invalid("Extraction schema too large.");
  }
  if (task.inputs && (Object.keys(task.inputs).length > 30 || Object.values(task.inputs).some(v => v.length > 20_000))) invalid("Inputs exceed their storage budget.");
  const fieldKeys = new Set<string>();
  for (const f of task.recovery?.fields ?? []) {
    scope(f);
    if (!/^[a-zA-Z][\w-]{0,63}$/.test(f.key) || fieldKeys.has(f.key) || !f.selector.trim()) invalid("Invalid recovery field.");
    fieldKeys.add(f.key);
  }
  if (!Number.isInteger(task.recovery?.maxAttempts ?? 3) || (task.recovery?.maxAttempts ?? 3) < 1 || (task.recovery?.maxAttempts ?? 3) > 5) invalid("maxAttempts must be 1..5.");
  if (task.recovery?.reconstruct?.length && task.recovery.reconstruct[0]?.kind !== "navigate") invalid("Reconstruction must begin with a repeat-safe UI navigation.");
  if (task.recovery?.reconcile?.length && !task.recovery.reconcileOutcome) invalid("Reconciliation requires a declared completed or not_applied outcome.");
  if (task.steps && !task.steps.length) invalid("Provide at least one explicit step or omit steps for autonomous execution.");
  if ((task.recovery?.reconstruct?.length ?? 0) > 100) invalid("Reconstruction plan is too large.");
  if (fieldKeys.size > 30) invalid("At most 30 recovery fields.");
  for (const [steps, reconstruction] of [[task.steps ?? [], false], [task.recovery?.reconstruct ?? [], true]] as const) {
    const ids = new Set<string>();
    for (const s of steps) {
      scope(s);
      if (s.id && (ids.has(s.id) || !/^[\w-]{1,80}$/.test(s.id))) invalid("Duplicate or invalid step id.");
      if (s.id) ids.add(s.id);
      if (reconstruction && (s.safeToRepeat !== true || s.kind === "goal")) invalid("Reconstruction requires explicit repeat-safe UI steps, not an autonomous goal.");
      if (["click", "fill", "press", "select", "check"].includes(s.kind) && !s.selector) invalid(`${s.kind} requires selector.`);
      const values = [s.value, s.valueFromEnv, s.valueFromInput, s.valueFromRecovery].filter(v => v !== undefined);
      if (["navigate", "fill", "press", "select", "check", "scroll"].includes(s.kind) && values.length !== 1) invalid(`${s.kind} requires exactly one value source.`);
      if (s.valueFromInput && (!/^[a-zA-Z][\w-]{0,63}$/.test(s.valueFromInput) || task.inputs?.[s.valueFromInput] === undefined)) invalid("A named step input is missing.");
      if (s.valueFromEnv && !/^[A-Z_][A-Z_0-9]{0,127}$/.test(s.valueFromEnv)) invalid("Invalid environment reference.");
      if (s.valueFromRecovery && !fieldKeys.has(s.valueFromRecovery)) invalid("Recovery key is not allowlisted.");
      if (s.kind === "goal" && !s.goal?.trim()) invalid("goal step requires a goal.");
      if (s.kind === "checkpoint" && !s.checks?.length) invalid("checkpoint requires assertions.");
      if (s.checks?.length) validateTest({ ...task, name: "checkpoint", checks: s.checks });
    }
  }
  for (const checks of [task.preconditions, task.recovery?.reconcile]) if (checks) validateTest({ ...task, name: "preconditions", checks });
}
