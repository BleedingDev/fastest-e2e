import * as fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { BrowserError } from "./contracts.js";
import type { Task, Report } from "./task.js";

export type Data = Record<string, unknown>;
export interface Event { version: 1; seq: number; at: number; type: string; data: Data }
export interface Meta { version: 2; runId: string; createdAt: number; expiresAt: number; profileDir: string; testing: boolean; task: Task; digest: string }
export interface Checkpoint { documentId: string; fingerprint: string; url: string; at: number }
export interface Attempt { index: number; mode: string; engine: string; startedAt: number; allocatedMs: number; durationMs?: number; status?: string; reasonCode?: string }
export interface State {
  meta: Meta; revision: number; status: "done" | "passed" | "failed" | "blocked";
  reasonCode: string; reason: string; running: boolean; attempts: Attempt[];
  targetId: string; browserId: string; targets: { targetId: string; browserId: string; role: string; closed: boolean }[]; tabRetained: boolean; finalUrl: string;
  checkpoint?: Checkpoint; scopeFingerprint?: string; actionsUsed: number; modelCallsUsed: number; activeMs: number;
  pendingAction: string | null; pendingSafe: boolean; pendingStep: number | null; hasUnsafeActions: boolean; resumeForbidden: boolean; unresolvedEffect: boolean; nextStep: number;
  checks: Data[]; extraction: Data; recovered: boolean; evidence: string[];
}
export const digest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function privateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink()) throw new BrowserError({ code: "storage", reason: "Storage directories must not be symlinks." });
}
export function atomic(file: string, value: unknown): void {
  privateDir(path.dirname(file));
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  // Persist the directory entry where the platform permits directory fsync.
  try { const d = fs.openSync(path.dirname(file), "r"); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch { /* Windows does not support this. */ }
}
export class Journal {
  readonly dir: string;
  constructor(readonly root: string, readonly runId: string) {
    if (!/^r_[a-f0-9]{32}$/.test(runId)) throw new BrowserError({ code: "run", reason: "Invalid run ID." });
    this.dir = path.join(root, "runs", runId);
  }
  get file(): string { return path.join(this.dir, "events.jsonl"); }
  meta(): Meta {
    let m: Meta;
    try { m = JSON.parse(fs.readFileSync(path.join(this.dir, "task.json"), "utf8")) as Meta; }
    catch { throw new BrowserError({ code: "run", reason: "Run not found in this configured home." }); }
    if (m.version !== 2 || m.runId !== this.runId) throw new BrowserError({ code: "run", reason: "Unsupported or invalid saved run." });
    if (Date.now() > m.expiresAt) throw new BrowserError({ code: "expired", reason: "Run expired. Use prune to remove retained data; create a new task." });
    return m;
  }
  events(): Event[] {
    let text: string;
    try { text = fs.readFileSync(this.file, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
    const lines = text.split("\n");
    lines.pop(); // An interrupted final append is never a dispatch receipt.
    return lines.filter(Boolean).map((line, i) => {
      let event: Event;
      try { event = JSON.parse(line) as Event; } catch { throw new BrowserError({ code: "journal", reason: "Corrupt event journal; no actions may be replayed." }); }
      if (event.version !== 1 || event.seq !== i + 1) throw new BrowserError({ code: "journal", reason: "Event sequence is invalid." });
      return event;
    });
  }
  append(type: string, data: Data = {}): Event {
    const events = this.events();
    const event: Event = { version: 1, seq: events.length + 1, at: Date.now(), type, data };
    privateDir(this.dir);
    // Remove only an incomplete last line, never recover silently from middle corruption.
    if (fs.existsSync(this.file)) {
      const old = fs.readFileSync(this.file);
      const end = old.lastIndexOf(10) + 1;
      if (end !== old.length) fs.truncateSync(this.file, end);
    }
    const fd = fs.openSync(this.file, "a", 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(event)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return event;
  }
  state(): State { return project(this.meta(), this.events()); }
  evidence(kind: string, value: Data): string {
    const id = `e_${randomUUID().replaceAll("-", "")}`;
    atomic(path.join(this.dir, "evidence", `${id}.json`), { id, kind, at: Date.now(), ...value });
    this.append("evidence", { id, kind });
    return id;
  }
  readEvidence(id: string): Data {
    if (!/^e_[a-f0-9]{32}$/.test(id)) throw new BrowserError({ code: "evidence", reason: "Invalid evidence ID." });
    return JSON.parse(fs.readFileSync(path.join(this.dir, "evidence", `${id}.json`), "utf8")) as Data;
  }
  recoveryFields(): Record<string, { value: string; source: string; at: number }> {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, "recovery.json"), "utf8")); } catch { return {}; }
  }
  saveField(key: string, value: string, source: "intent" | "observed"): void {
    if (!this.meta().task.recovery?.fields?.some(f => f.key === key)) throw new BrowserError({ code: "recovery", reason: "Recovery field not allowlisted." });
    atomic(path.join(this.dir, "recovery.json"), { ...this.recoveryFields(), [key]: { value, source, at: Date.now() } });
  }
}
export function createRun(root: string, task: Task, testing: boolean, profileDir: string): { journal: Journal; duplicate: boolean } {
  privateDir(path.join(root, "requests"));
  const inputDigest = digest({ task, testing, profileDir });
  const requestPath = task.requestId ? path.join(root, "requests", `${digest(task.requestId)}.json`) : undefined;
  if (requestPath && fs.existsSync(requestPath)) {
    const old = JSON.parse(fs.readFileSync(requestPath, "utf8")) as { digest: string; runId: string };
    if (old.digest !== inputDigest) throw new BrowserError({ code: "request_conflict", reason: "This requestId was already used with different inputs." });
    const journal = new Journal(root, old.runId); journal.meta();
    return { journal, duplicate: true };
  }
  const runId = `r_${randomUUID().replaceAll("-", "")}`;
  const journal = new Journal(root, runId);
  const meta: Meta = { version: 2, runId, createdAt: Date.now(), expiresAt: Date.now() + (task.retentionHours ?? 24) * 3_600_000, task, testing, profileDir, digest: inputDigest };
  atomic(path.join(journal.dir, "task.json"), meta);
  journal.append("created", { digest: inputDigest });
  if (requestPath) atomic(requestPath, { digest: inputDigest, runId });
  return { journal, duplicate: false };
}
export function project(meta: Meta, events: Event[]): State {
  const s: State = { meta, revision: events.length, status: "blocked", reasonCode: "not_started", reason: "No execution completed.", running: false,
    attempts: [], targetId: "", browserId: "", targets: [], tabRetained: false, finalUrl: "", actionsUsed: 0, modelCallsUsed: 0, activeMs: 0,
    pendingAction: null, pendingSafe: false, pendingStep: null, hasUnsafeActions: false, resumeForbidden: false, unresolvedEffect: false, nextStep: 0, checks: [], extraction: {}, recovered: false, evidence: [] };
  for (const e of events) {
    const d = e.data;
    switch (e.type) {
      case "attempt.start":
        s.running = true;
        s.attempts.push({ index: s.attempts.length, mode: String(d.mode), engine: String(d.engine), startedAt: e.at, allocatedMs: Number(d.allocatedMs) });
        s.recovered ||= s.attempts.length > 1;
        break;
      case "attempt.end": {
        const a = s.attempts.at(-1);
        if (a) { a.durationMs = Number(d.durationMs); a.status = String(d.status); a.reasonCode = String(d.reasonCode); }
        s.running = false; s.status = d.status as State["status"]; s.reasonCode = String(d.reasonCode); s.reason = String(d.reason ?? ""); break;
      }
      case "preflight.failed": s.reasonCode = String(d.code); s.reason = String(d.reason); break;
      case "target": delete s.scopeFingerprint; s.targetId = String(d.targetId); s.browserId = String(d.browserId); s.tabRetained = true; s.targets.push({ targetId: s.targetId, browserId: s.browserId, role: "task", closed: false }); break;
      case "popup": if (typeof d.targetId === "string" && typeof d.browserId === "string") s.targets.push({ targetId: d.targetId, browserId: d.browserId, role: "popup", closed: false }); break;
      case "closed": for (const t of s.targets) if (!d.targetId || t.targetId === d.targetId) t.closed = true; if (!d.targetId || d.targetId === s.targetId) s.tabRetained = false; break;
      case "checkpoint": s.checkpoint = { documentId: String(d.documentId), fingerprint: String(d.fingerprint), url: String(d.url), at: e.at }; s.finalUrl = String(d.url); break;
      case "scope.checkpoint": s.scopeFingerprint = String(d.fingerprint); break;
      case "action.start": s.actionsUsed++; s.pendingAction = String(d.id); s.pendingSafe = d.safeToRepeat === true; s.pendingStep = Number.isInteger(d.step) ? Number(d.step) : null; if (!s.pendingSafe) { s.unresolvedEffect = true; s.hasUnsafeActions = true; } break;
      case "action.end": if (s.pendingAction === d.id) s.pendingAction = null; break;
      case "action.not_dispatched": if (s.pendingAction === d.id) s.pendingAction = null; break;
      case "call.start": s.modelCallsUsed++; break;
      case "step.done": s.nextStep = Number(d.index) + 1; if (s.pendingAction === d.id) s.pendingAction = null; break;
      case "steps.reset": s.nextStep = 0; break;
      case "reconciled": s.pendingAction = null; s.unresolvedEffect = false; s.resumeForbidden = d.continuationForbidden === true; if (Number.isInteger(d.nextStep)) s.nextStep = Number(d.nextStep); break;
      case "safe_repeat": if (s.pendingSafe && !s.unresolvedEffect) s.pendingAction = null; break;
      case "verified_checkpoint": s.unresolvedEffect = false; break;
      case "checks": s.checks = d.results as Data[]; break;
      case "extraction": s.extraction = Object.fromEntries(Object.entries(d.fields as Data).map(([key,value]) => [key, { ...(value as Data), evidenceRef: (value as Data).evidenceRef ?? d.evidenceRef }])); break;
      case "evidence": s.evidence.push(String(d.id)); break;
    }
  }
  s.activeMs = events.filter(e => e.type === "observation.time").reduce((n,e) => n + Number(e.data.durationMs), 0) + s.attempts.reduce((sum, a) => sum + (a.durationMs ?? Math.min(a.allocatedMs, Math.max(0, Date.now() - a.startedAt))), 0);
  return s;
}
export function remaining(s: State) { return { actions: Math.max(0, (s.meta.task.maxSteps ?? 30) - s.actionsUsed),
  modelCalls: Math.max(0, (s.meta.task.maxModelCalls ?? 60) - s.modelCallsUsed),
  activeMs: Math.max(0, (s.meta.task.timeoutMs ?? 120_000) - s.activeMs) }; }
export function summary(s: State): Report {
  const nextActions: Data[] = [{ operation: "inspect", arguments: { runId: s.meta.runId, view: "page" } }];
  if (!s.running && s.status === "blocked" && !s.pendingAction && s.tabRetained && !s.resumeForbidden) nextActions.push({ operation: "resume", requiresLiveValidation: true, arguments: { runId: s.meta.runId, expectedRevision: s.revision, mode: "resume" } });
  return { schemaVersion: 2, runId: s.meta.runId, revision: s.revision, status: s.status, verified: s.status === "passed",
    ...(s.meta.task.name ? { name: s.meta.task.name } : {}), ...(s.meta.task.changeRef ? { changeRef: s.meta.task.changeRef } : {}),
    task: { url: s.meta.task.url, goal: s.meta.task.goal },
    progress: { nextStep: s.nextStep, totalSteps: s.meta.task.steps?.length ?? 1,
      pending: s.meta.task.steps?.[s.nextStep] ? { kind: s.meta.task.steps[s.nextStep]!.kind, id: s.meta.task.steps[s.nextStep]!.id, selector: s.meta.task.steps[s.nextStep]!.selector, frames: s.meta.task.steps[s.nextStep]!.frames } : null },
    execution: { state: s.running ? "interrupted_or_running" : s.status, reasonCode: s.reasonCode },
    reason: s.pendingAction ? "An action was dispatched without a completion receipt. Reconcile its effect before recovery." : s.reason,
    targetId: s.targetId, browserId: s.browserId, ownedTargets: s.targets, tabRetained: s.tabRetained, finalUrl: s.finalUrl,
    durationMs: s.activeMs, engineMs: s.activeMs, actions: s.actionsUsed, checks: s.checks, extraction: s.extraction,
    mutation: { state: s.pendingAction ? "uncertain" : s.unresolvedEffect ? "unverified" : "clear" },
    attempts: s.attempts, recovered: s.recovered, budget: { ...remaining(s), modelCost: { kind: "unknown" } },
    checkpoint: s.checkpoint ?? null, evidenceRefs: s.evidence.slice(-10), nextActions };
}
export function prune(root: string): number {
  let count = 0;
  if (!fs.existsSync(path.join(root, "runs"))) return 0;
  for (const entry of fs.readdirSync(path.join(root, "runs"), { withFileTypes: true }).filter(e => e.isDirectory())) {
    if (!/^r_[a-f0-9]{32}$/.test(entry.name)) continue;
    const dir = path.join(root, "runs", entry.name);
    const m = JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8")) as Meta;
    if (m.expiresAt < Date.now()) { fs.rmSync(dir, { recursive: true }); count++; }
  }
  return count;
}
