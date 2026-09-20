// Explicit, local procedure reuse. No hidden learner, cached answers, or learned permissions.
import * as fs from "node:fs";
import path from "node:path";
import { Journal, atomic, digest } from "./journal.js";
import type { Task, Step } from "./task.js";
import type { Check } from "./contracts.js";
import { BrowserError } from "./contracts.js";
interface Recipe {
  version: 1; name: string; state: "candidate" | "approved" | "quarantined";
  origin: string; pathname: string; steps: readonly Step[]; preconditions: readonly Check[];
  signature: string; sourceRunId: string; trialRunId?: string; expiresAt: number; reason?: string;
}
function recipePath(root: string, name: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new BrowserError({ code: "recipe", reason: "Recipe names use lowercase letters, digits and hyphens." });
  return path.join(root, "recipes", `${name}.json`);
}
function procedure(task: Task) {
  if (!task.steps?.length || task.steps.some(s => s.kind === "goal" || s.kind === "checkpoint" || s.checks?.length)) {
    throw new BrowserError({ code: "recipe", reason: "Only explicit UI procedures without embedded test expectations can be reused. Keep current checks in the calling task." });
  }
  if (!task.preconditions?.length) throw new BrowserError({ code: "recipe", reason: "A reusable procedure requires explicit account/UI preconditions." });
  const url = new URL(task.url);
  for (const step of task.steps) {
    if (step.kind === "fill" && !step.valueFromInput && !step.valueFromEnv) throw new BrowserError({ code: "recipe", reason: "Parameterize fill values with valueFromInput or valueFromEnv before proposing reuse." });
    if (step.valueFromRecovery) throw new BrowserError({ code: "recipe", reason: "Run-local recovery payloads cannot be copied into reusable procedures." });
    if (step.kind === "navigate" && (!step.value || new URL(step.value).origin !== url.origin)) throw new BrowserError({ code: "recipe", reason: "Recipe navigation must stay on its reviewed origin." });
  }
  // Permission to repeat an operation never comes from learned history.
  const steps = task.steps.map(({ safeToRepeat: _permission, ...step }) => step);
  return { origin: url.origin, pathname: url.pathname, steps, preconditions: task.preconditions };
}
function load(root: string, name: string): Recipe {
  try { const record = JSON.parse(fs.readFileSync(recipePath(root, name), "utf8")) as Recipe;
    if (record.version !== 1 || record.name !== name || digest({ origin: record.origin, pathname: record.pathname, steps: record.steps, preconditions: record.preconditions }) !== record.signature) throw new Error("invalid");
    return record;
  } catch { throw new BrowserError({ code: "recipe", reason: "Recipe is missing or invalid. No procedure was executed." }); }
}
export function proposeRecipe(root: string, runId: string, name: string): Recipe {
  const state = new Journal(root, runId).state();
  if (state.status !== "passed" || state.recovered) throw new BrowserError({ code: "recipe", reason: "Use an independently checked, uninterrupted successful run as the candidate source." });
  const body = procedure(state.meta.task); const file = recipePath(root, name);
  if (fs.existsSync(file)) throw new BrowserError({ code: "recipe", reason: "Recipe already exists; choose a new versioned name or remove it explicitly." });
  const candidate: Recipe = { version: 1, name, state: "candidate", ...body, signature: digest(body), sourceRunId: runId, expiresAt: Date.now() + 7 * 86_400_000 };
  atomic(file, candidate); return candidate;
}
export function approveRecipe(root: string, name: string, trialRunId: string): Recipe {
  const recipe = load(root, name); const trial = new Journal(root, trialRunId).state();
  if (recipe.state !== "candidate" || recipe.expiresAt <= Date.now() || trialRunId === recipe.sourceRunId || trial.status !== "passed" || trial.recovered || digest(procedure(trial.meta.task)) !== recipe.signature) {
    throw new BrowserError({ code: "recipe", reason: "Approval requires a distinct successful, uninterrupted trial of the same procedure and preconditions. Review the candidate first." });
  }
  const approved: Recipe = { ...recipe, state: "approved", trialRunId }; atomic(recipePath(root, name), approved); return approved;
}
export function applyRecipe(root: string, task: Task): Task {
  if (!task.recipe) return task;
  if (task.steps) throw new BrowserError({ code: "recipe", reason: "Supply a reviewed recipe or explicit steps, not both." });
  const recipe = load(root, task.recipe); const url = new URL(task.url);
  if (recipe.state !== "approved" || recipe.expiresAt <= Date.now() || url.origin !== recipe.origin || url.pathname !== recipe.pathname) throw new BrowserError({ code: "recipe_scope", reason: "Recipe is unapproved, expired, quarantined, or outside this origin/path. No browser action was performed." });
  return { ...task, steps: recipe.steps, preconditions: [...recipe.preconditions, ...(task.preconditions ?? [])] };
}
export function quarantineRecipe(root: string, name: string, reason: string): void {
  const recipe = load(root, name); atomic(recipePath(root, name), { ...recipe, state: "quarantined", reason });
}
export function listRecipes(root: string) {
  const directory = path.join(root, "recipes");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(n => /^[a-z][a-z0-9-]{0,63}\.json$/.test(n)).map(n => {
    const r = load(root, n.slice(0,-5)); return { name: r.name, state: r.state, origin: r.origin, pathname: r.pathname, expiresAt: r.expiresAt, sourceRunId: r.sourceRunId };
  });
}
export function forgetRecipe(root: string, name: string): void { fs.unlinkSync(recipePath(root, name)); }
