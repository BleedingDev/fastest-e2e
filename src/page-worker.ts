import * as fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { Browser, Page, Locator, FrameLocator, ElementHandle, Frame } from "playwright-core";
import { BrowserError, type Check } from "./contracts.js";
import { Journal, remaining, digest, atomic, type Data } from "./journal.js";
import { Cdp, checkpoint, liveStateExpression } from "./cdp.js";
import { readElement, readPage } from "./dom.js";
import type { Session } from "./host.js";
import type { Step, Extraction } from "./task.js";

export interface PageJob { root: string; runId: string; session: Session; targetId: string;
  operation: "steps" | "vision" | "checks" | "extract" | "capture" | "continuity" | "inspect";
  observationRunId?: string; scope?: Scoped; limit?: number;
  steps?: readonly Step[]; startIndex?: number; goal?: string; checks?: readonly Check[]; extract?: readonly Extraction[];
  timeoutMs: number; saveProgress?: boolean }
export type Scoped = { selector?: string | undefined; frames?: readonly string[] | undefined; shadow?: string | undefined };
export function parentGuard(): void {
  const expected = process.env.FASTEST_E2E_CALLER_PID;
  if (expected && process.ppid !== Number(expected)) throw new BrowserError({ code: "cancelled", reason: "The controlling process ended. No further action will be sent." });
}
export async function attachPage(session: Session, targetId: string): Promise<{ browser: Browser; page: Page }> {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.connectOverCDP(session.wsUrl, { noDefaults: true, timeout: 5_000 });
  try {
    for (const context of browser.contexts()) for (const page of context.pages()) {
      const cdp = await context.newCDPSession(page);
      try {
        const info = await cdp.send("Target.getTargetInfo");
        if (info.targetInfo.targetId === targetId) return { browser, page };
      } finally { await cdp.detach(); }
    }
    throw new BrowserError({ code: "target_lost", reason: "The owned task tab no longer exists. No replacement tab was chosen." });
  } catch (e) { await browser.close(); throw e; }
}
function css(selector: string, shadow?: string): string { return `${shadow === "open" ? "css" : "css:light"}=${selector}`; }
export async function scoped(page: Page, s: Scoped): Promise<{ root: Page | FrameLocator; locator: Locator }> {
  if (s.shadow === "closed") throw new BrowserError({ code: "unsupported_scope", reason: "Closed shadow-root DOM access is unsupported. Use explicitly requested visual evidence." });
  let root: Page | FrameLocator = page;
  for (const selector of s.frames ?? []) {
    const iframe = root.locator(css(selector, s.shadow));
    if (await iframe.count() === 0) await iframe.first().waitFor({ state: "attached", timeout: 3_000 }).catch(() => undefined);
    if (await iframe.count() !== 1 || !(await iframe.evaluate(e => /^(IFRAME|FRAME)$/.test(e.tagName)))) {
      throw new BrowserError({ code: "unsupported_scope", reason: "The frame path did not identify exactly one frame. Absence inside it is unknown." });
    }
    root = root.frameLocator(css(selector, s.shadow));
  }
  return { root, locator: root.locator(css(s.selector ?? "body", s.shadow)) };
}
export async function checkOne(page: Page, c: Check): Promise<Data> {
  if (c.kind === "visual") throw new BrowserError({ code: "vision_required", reason: "This check requires the configured vision adapter." });
  const base = { kind: c.kind, expected: c.value, method: "dom", ...(c.id ? { id: c.id } : {}) };
  const { root, locator } = await scoped(page, c);
  let actual: string; let available = true;
  if (c.kind === "url") actual = await root.locator("html").evaluate(() => location.href);
  else {
    const count = await locator.count();
    if (c.kind === "count") actual = String(count);
    else if (c.kind === "visible" && count === 0) actual = "false";
    else if (count !== 1) { actual = `<${count} matching elements>`; available = false; }
    else {
      const value = await locator.evaluate(readElement, c);
      if (value.error) throw new BrowserError({ code: "verification", reason: value.error });
      actual = value.actual; available = value.available !== false;
    }
  }
  return { ...base, actual: actual.slice(0, 2048), passed: available && (c.kind === "text" ? actual.includes(c.value) : actual === c.value) };
}
export async function pollChecks(page: Page, checks: readonly Check[], timeoutMs: number): Promise<Data[]> {
  const end = Date.now() + timeoutMs;
  while (true) {
    const results = await Promise.all(checks.map(c => checkOne(page, c)));
    if (results.every(r => r.passed === true) || Date.now() >= end) return results;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
async function captureFields(page: Page, journal: Journal): Promise<void> {
  const task = journal.meta().task;
  const fields = task.recovery?.fields ?? [];
  const protectedSteps = [...(task.steps ?? []), ...(task.recovery?.reconstruct ?? [])]
    .filter(s => s.valueFromEnv !== undefined && s.selector !== undefined);
  const handles: ElementHandle[] = [];
  try {
    const protectedNodes: { node: ElementHandle; frame: Frame | null }[] = [];
    for (const step of protectedSteps) {
      const { locator } = await scoped(page, step);
      const nodes = await locator.elementHandles();
      handles.push(...nodes);
      for (const node of nodes) protectedNodes.push({ node, frame: await node.ownerFrame() });
    }
    for (const f of fields) {
      const { locator } = await scoped(page, f);
      const nodes = await locator.elementHandles();
      handles.push(...nodes);
      if (nodes.length !== 1) continue;
      const node = nodes[0]!;
      const frame = await node.ownerFrame();
      const candidates = protectedNodes.filter(p => p.frame === frame).map(p => p.node);
      // Pin the recovery target to one DOM node, then compare identity and read
      // its value in the same page evaluation. A rerender cannot swap the
      // recovery selector to an environment-backed control between the guard
      // and the read.
      const result = await node.evaluate((element, others) => {
        if (others.includes(element)) return { actual: "", protected: true };
        const sensitive = element.matches('input[type=password], input[type=file], [autocomplete="one-time-code"]');
        const rect = element.getBoundingClientRect();
        const visible = !!rect.width && !!rect.height && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
        if (!visible) return { actual: "", available: false };
        if (sensitive) return { actual: "", error: "Sensitive control values cannot be collected." };
        if (!("value" in element)) return { actual: "", error: "Target is not a value control." };
        return { actual: String((element as HTMLInputElement).value) };
      }, candidates);
      if (result.protected) {
        throw new BrowserError({ code: "retention_forbidden", reason: "An environment-backed control overlaps the recovery allowlist. Remove it and use its environment reference for reconstruction." });
      }
      if (result.error) throw new BrowserError({ code: "retention_forbidden", reason: "A recovery allowlist includes a sensitive or unsupported control. Remove it; no value was saved." });
      if (result.available === false) continue;
      journal.saveField(f.key, result.actual, "observed");
    }
  } finally { await Promise.allSettled(handles.map(handle => handle.dispose())); }
}
function valueFor(s: Step, journal: Journal, retained = journal.recoveryFields()): string {
  if (s.valueFromInput) {
    const value = journal.meta().task.inputs?.[s.valueFromInput];
    if (value === undefined) throw new BrowserError({ code: "input_required", reason: "A named task input is missing." });
    return value;
  }
  if (s.valueFromEnv) {
    const value = process.env[s.valueFromEnv];
    if (value === undefined) throw new BrowserError({ code: "input_required", reason: `Set local environment variable ${s.valueFromEnv}; its value is not saved in the run.` });
    return value;
  }
  if (s.valueFromRecovery) {
    const saved = retained[s.valueFromRecovery];
    if (!saved) throw new BrowserError({ code: "input_lost", reason: `No retained recovery input for ${s.valueFromRecovery}. Re-enter it locally or choose a safe restart.` });
    return saved.value;
  }
  return s.value ?? "";
}
async function runSteps(page: Page, journal: Journal, job: PageJob, snap: () => Promise<void>, signal: AbortSignal): Promise<void> {
  const retained = journal.recoveryFields();
  const rebuilding = job.saveProgress === false;
  for (const [offset, s] of (job.steps ?? []).entries()) {
    parentGuard(); signal.throwIfAborted();
    const index = (job.startIndex ?? 0) + offset;
    const value = valueFor(s, journal, rebuilding ? retained : journal.recoveryFields());
    const { locator } = await scoped(page, s);
    if (["click", "fill", "press", "select", "check"].includes(s.kind) && await locator.count() === 0) await locator.first().waitFor({ state: "attached", timeout: 3_000 });
    if (["click", "fill", "press", "select", "check"].includes(s.kind) && await locator.count() !== 1) {
      throw new BrowserError({ code: "ambiguous_target", reason: "Action requires one matching control. Inspect the scoped page; no action was dispatched." });
    }
    if (!rebuilding) await captureFields(page, journal);
    else if (s.valueFromEnv) await assertRecoveryTargets(page, journal);
    if (s.kind === "fill") for (const f of journal.meta().task.recovery?.fields ?? []) {
      if (f.selector === s.selector && JSON.stringify(f.frames) === JSON.stringify(s.frames) && f.shadow === s.shadow && !s.valueFromEnv) {
        const result = await locator.evaluate(readElement, { kind: "value" });
        if (result.error) throw new BrowserError({ code: "retention_forbidden", reason: "Sensitive inputs cannot be retained." });
        journal.saveField(f.key, value, "intent");
      }
    }
    // Reject invalid values before recording a dispatch boundary.
    if (s.kind === "navigate") { const u = new URL(value); if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) throw new BrowserError({ code: "input", reason: "Only HTTP(S) navigation without embedded credentials is supported." }); }
    if (s.kind === "check" && !["true", "false"].includes(value)) throw new BrowserError({ code: "input", reason: "check requires true or false." });
    if (s.kind === "scroll" && (!Number.isFinite(Number(value)) || Math.abs(Number(value)) > 10_000)) throw new BrowserError({ code: "input", reason: "Invalid scroll distance." });
    let actionId: string | undefined;
    if (s.kind !== "checkpoint") {
      if (remaining(journal.state()).actions <= 0) throw new BrowserError({ code: "budget_exhausted", reason: "Action budget exhausted." });
      actionId = randomUUID();
      journal.append("action.start", { id: actionId, kind: s.kind, safeToRepeat: s.safeToRepeat === true, step: index, selector: s.selector, frames: s.frames, engine: "playwright" });
    }
    switch (s.kind) {
      case "navigate": {
        const u = new URL(value); if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) throw new BrowserError({ code: "input", reason: "Only HTTP(S) navigation without embedded credentials is supported." });
        await page.goto(value, { waitUntil: "domcontentloaded" }); break;
      }
      case "click": await locator.click(); break;
      case "fill": await locator.fill(value); break;
      case "press": await locator.press(value); break;
      case "select": await locator.selectOption(value); break;
      case "check": if (!["true", "false"].includes(value)) throw new BrowserError({ code: "input", reason: "check requires true or false." }); await locator.setChecked(value === "true"); break;
      case "scroll": { const delta = Number(value); if (!Number.isFinite(delta) || Math.abs(delta) > 10_000) throw new BrowserError({ code: "input", reason: "Invalid scroll distance." }); await page.mouse.wheel(0, delta); break; }
      case "checkpoint": break;
      default: throw new BrowserError({ code: "unsupported", reason: "This operation requires an autonomous executor." });
    }
    if (rebuilding && offset === 0 && journal.meta().task.preconditions?.length) {
      const results = await pollChecks(page, journal.meta().task.preconditions!, 3_000);
      if (!results.every(r => r.passed)) throw new BrowserError({ code: "precondition_failed", reason: "Reconstruction account/UI preconditions did not hold; no fields were refilled." });
    }
    if (s.checks?.length) {
      const results = await pollChecks(page, s.checks, 3_000);
      const ref = journal.evidence("checkpoint_checks", { index, results });
      journal.append("checks", { results, evidenceRef: ref });
      if (!results.every(r => r.passed)) throw new BrowserError({ code: "assertion_failed", reason: "A checkpoint assertion failed. The UI will not be repaired to make it pass." });
      journal.append("verified_checkpoint", { index });
    }
    await snap(); if (!rebuilding) await captureFields(page, journal);
    // One durable completion record advances the cursor and clears dispatch uncertainty.
    journal.append(job.saveProgress === false ? "action.end" : "step.done", { index, ...(actionId ? { id: actionId } : {}) });
  }
  if (rebuilding) await captureFields(page, journal);
}

export interface ModelImage { bytes: Buffer; mimeType: string; at: number }
export async function makeVision(page: Page, journal: Journal, snap: () => Promise<void>, signal: AbortSignal, onImage?: (image: ModelImage) => void) {
  if (process.env.FASTEST_E2E_VISION_ENABLED !== "1") throw new BrowserError({ code: "vision_disabled", reason: "Enable vision in local config and supply MIDSCENE_MODEL_* settings." });
  for (const key of ["MIDSCENE_MODEL_API_KEY", "MIDSCENE_MODEL_BASE_URL", "MIDSCENE_MODEL_NAME", "MIDSCENE_MODEL_FAMILY"]) {
    if (!process.env[key]) throw new BrowserError({ code: "vision_unconfigured", reason: `${key} is missing from the invoking environment.` });
  }
  const blocked = (code: string, reason: string): never => { journal.append("stop.reason", { code, reason }); throw new BrowserError({ code, reason }); };
  const { PlaywrightAgent } = await import("@midscene/web/playwright/agent");
  let pending: string | undefined;
  return new PlaywrightAgent(page, {
    forceSameTabNavigation: false, forceChromeSelectRendering: false,
    generateReport: false, persistExecutionDump: false, autoPrintReportMsg: false, cache: false,
    waitForNetworkIdleTimeout: 0, waitForNavigationTimeout: 1_000, waitAfterAction: 100,
    replanningCycleLimit: Math.max(1, Math.min(20, remaining(journal.state()).actions)),
    beforeInvokeAction: async (...args: unknown[]) => {
      parentGuard(); signal.throwIfAborted();
      if (args[0] === "RegisterFileChooserAccept") blocked("upload_requires_scope", "Autonomous file selection is disabled. Use explicitly reviewed local browser scripting for authorized uploads.");
      if (remaining(journal.state()).actions <= 0) blocked("budget_exhausted", "Action budget exhausted.");
      await captureFields(page, journal);
      pending = randomUUID(); journal.append("action.start", { id: pending, kind: typeof args[0] === "string" ? args[0] : "visual_action", safeToRepeat: false, engine: "midscene" });
    },
    afterInvokeAction: async () => { await snap(); if (pending) journal.append("action.end", { id: pending }); pending = undefined; },
    createOpenAIClient: async client => {
      // Preserve the SDK's APIPromise and streaming interface. Meter before dispatch.
      for (const endpoint of [client.chat?.completions, client.responses]) if (endpoint?.create) {
        const original = endpoint.create.bind(endpoint);
        endpoint.create = (...args: unknown[]) => {
          parentGuard(); signal.throwIfAborted();
          if (remaining(journal.state()).modelCalls <= 0) blocked("budget_exhausted", "Model-call budget exhausted.");
          journal.append("call.start", { engine: "midscene" });
          if (onImage) {
            const scan = (v: unknown, depth = 0): void => {
              if (depth > 20) return;
              if (typeof v === "string") { const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(v);
                if (match && match[2]!.length < 8_000_000) onImage({ bytes: Buffer.from(match[2]!, "base64"), mimeType: match[1]!, at: Date.now() });
              } else if (v && typeof v === "object") for (const child of Object.values(v)) scan(child, depth + 1);
            }; scan(args[0]);
          }
          const response = original(...args);
          void response.catch((error: { status?: number }) => {
            if (typeof error.status === "number") journal.append("stop.reason", { code: error.status === 401 || error.status === 403 ? "model_credentials" : error.status === 429 ? "model_rate_limit" : "model_unavailable", reason: `The configured provider returned HTTP ${error.status}. No browser action was retried.` });
          });
          return response;
        };
      }
      client.maxRetries = 0; return client;
    },
    onLLMUsage: usage => journal.append("usage", Object.fromEntries(Object.entries(usage).filter(([k, v]) => /tokens|timeCost|cached/i.test(k) && typeof v === "number"))),
  });
}
export async function pageJob(job: PageJob, signal: AbortSignal): Promise<Data> {
  const journal = new Journal(job.root, job.runId);
  const state = journal.state();
  if (job.observationRunId && !["checks", "continuity"].includes(job.operation)) throw new BrowserError({ code: "input", reason: "Cross-run observation is read-only verification." });
  const observed = job.observationRunId ? new Journal(job.root, job.observationRunId).state() : state;
  if (observed.targetId !== job.targetId || !observed.tabRetained || observed.browserId !== job.session.browserId || observed.meta.profileDir !== job.session.profileDir || state.meta.profileDir !== job.session.profileDir) {
    throw new BrowserError({ code: "session_changed", reason: "Page request does not match the run's exact target and profile." });
  }
  const { browser, page } = await attachPage(job.session, job.targetId);
  let popupSeen = false;
  const popupReceipts: Promise<void>[] = [];
  const popup = (opened: Page) => {
    popupSeen = true;
    popupReceipts.push((async () => {
      const c = await opened.context().newCDPSession(opened);
      try { const { targetInfo } = await c.send("Target.getTargetInfo");
        if (targetInfo.openerId === job.targetId) {
          atomic(path.join(job.root, "targets", job.session.namespace, `${targetInfo.targetId}.json`), { targetId: targetInfo.targetId, browserId: job.session.browserId });
          journal.append("popup", { targetId: targetInfo.targetId, openerId: job.targetId, browserId: job.session.browserId });
        }
      } finally { await c.detach(); }
    })().catch(() => { journal.append("popup", { openerId: job.targetId, unavailable: true }); }));
  };
  page.on("popup", popup);
  page.setDefaultTimeout(Math.max(100, Math.min(5_000, job.timeoutMs)));
  let raw: Cdp | undefined;
  let sid = "";
  const frameState = async () => digest(await Promise.all(page.frames().map(async frame => ({ url: frame.url(), parent: frame.parentFrame()?.url() ?? null, state: await frame.evaluate(liveStateExpression) }))));
  const snap = async () => { const c = await checkpoint(raw!, sid); journal.append("checkpoint", { ...c });
    journal.append("scope.checkpoint", { fingerprint: await frameState() });
    if (popupSeen) { await Promise.all(popupReceipts); throw new BrowserError({ code: "popup_opened", reason: "The action opened a new tab. Its opener was recorded; inspect before further work. No tab was silently selected." }); }
  };
  let vision: Awaited<ReturnType<typeof makeVision>> | undefined;
  let captured: ModelImage | undefined;
  const visual = async () => vision ??= await makeVision(page, journal, snap, signal, image => { captured = image; });
  const frozenQuery = async (kind: "check" | "extract", prompt: string) => {
    const agent = await visual();
    captured = undefined;
    await agent.freezePageContext();
    const observedAt = Date.now();
    try {
      signal.throwIfAborted(); parentGuard();
      const value = kind === "check" ? await agent.aiBoolean(prompt, { abortSignal: signal }) : await agent.aiQuery(prompt, { abortSignal: signal });
      const image = captured as ModelImage | undefined;
      if (!image) throw new BrowserError({ code: "visual_evidence", reason: "The adapter did not expose the image actually sent for this query." });
      const extension = image.mimeType === "image/jpeg" ? "jpg" : image.mimeType.split("/")[1]!;
      const ref = journal.evidence("visual_query", { expected: prompt, capturedAt: observedAt, sentAt: image.at, mimeType: image.mimeType, extension, method: "vision", targetId: job.targetId, document: await checkpoint(raw!, sid) });
      fs.writeFileSync(`${journal.dir}/evidence/${ref}.${extension}`, image.bytes, { mode: 0o600 });
      return { value, ref };
    } finally { await agent.unfreezePageContext(); }
  };
  try {
    parentGuard(); signal.throwIfAborted();
    raw = await Cdp.open(job.session); sid = await raw.attach(job.targetId);
    // Keep background UI actions live without bringing the user's window forward.
    if (job.operation === "steps" || job.operation === "vision") await raw.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sid);
    if (job.operation === "continuity") return { fingerprint: await frameState() };
    if (job.operation === "inspect") {
      const { locator } = await scoped(page, job.scope ?? {});
      if (await locator.count() !== 1) throw new BrowserError({ code: "ambiguous_target", reason: "Observation requires one matching region." });
      return locator.evaluate(readPage, { limit: Math.max(1, Math.min(100, job.limit ?? 20)), ...(job.scope?.shadow ? { shadow: job.scope.shadow } : {}) });
    }
    if (job.operation === "steps") { await runSteps(page, journal, job, snap, signal); return { ok: true }; }
    if (job.operation === "capture") { await captureFields(page, journal); return { ok: true }; }
    if (job.operation === "vision") {
      const agent = await visual();
      await agent.aiAct(job.goal ?? state.meta.task.goal, { cacheable: false, abortSignal: signal });
      await snap(); return { ok: true };
    }
    if (job.operation === "checks") {
      const results: Data[] = [];
      for (const c of job.checks ?? []) {
        if (c.kind !== "visual") results.push(...await pollChecks(page, [c], state.meta.task.checkTimeoutMs ?? 5_000));
        else {
          if (c.frames?.length || c.selector || c.shadow && c.shadow !== "none") throw new BrowserError({ code: "unsupported_scope", reason: "Visual assertions currently describe the full viewport, not a DOM-scoped crop." });
          const { value: answer, ref } = await frozenQuery("check", c.value);
          results.push({ kind: "visual", expected: c.value, actual: String(answer), passed: answer === true, method: "vision", evidenceRef: ref });
        }
      }
      return { results };
    }
    const fields: Data = {};
    for (const x of job.extract ?? []) {
      try {
      let value: unknown; let evidenceRef: string | undefined;
      if (x.kind === "visual") {
        if (x.frames?.length || x.selector || x.shadow && x.shadow !== "none") throw new BrowserError({ code: "unsupported_scope", reason: "Visual extraction describes the full viewport, not a scoped crop." });
        const result = await frozenQuery("extract", x.prompt!); value = result.value; evidenceRef = result.ref;
      }
      else if (x.kind === "url" || x.kind === "title") { const { root } = await scoped(page, x); value = await root.locator("html").evaluate((_e, kind) => kind === "url" ? location.href : document.title, x.kind); }
      else {
        const { locator } = await scoped(page, x);
        if (await locator.count() !== 1) throw new BrowserError({ code: "extraction", reason: `${x.name} did not identify exactly one element.` });
        const result = await locator.evaluate(readElement, x);
        if (result.error || result.available === false) throw new BrowserError({ code: "extraction", reason: `${x.name} cannot be read from the requested control.` });
        value = result.actual;
      }
      if (x.schema) {
        const { Ajv } = await import("ajv"); const validate = new Ajv({ strict: true, allErrors: true }).compile(x.schema);
        if (!validate(value)) throw new BrowserError({ code: "extraction_schema", reason: `${x.name} did not match its declared JSON Schema. No value was invented.` });
      }
      if (JSON.stringify(value)?.length > 40_000) throw new BrowserError({ code: "extraction_limit", reason: "Requested field is too large. Narrow the extraction." });
      fields[x.name] = { value, method: x.kind === "visual" ? "vision" : "dom", ...(evidenceRef ? { evidenceRef } : {}) };
      } catch (error) {
        fields[x.name] = { error: error instanceof BrowserError ? error.code : "extraction", reason: error instanceof BrowserError ? error.reason : "Field could not be read; no value was invented." };
      }
    }
    return { fields, complete: Object.values(fields).every(v => v !== null && typeof v === "object" && !("error" in v)) };
  } catch (error) {
    const stop = journal.events().findLast(e => e.seq > state.revision && e.type === "stop.reason");
    if (stop) throw new BrowserError({ code: String(stop.data.code), reason: String(stop.data.reason) });
    throw error;
  } finally {
    page.off("popup", popup);
    await vision?.destroy().catch(() => undefined);
    await Promise.allSettled(popupReceipts);
    await raw?.close();
    await browser.close(); // connectOverCDP: disconnect only; never launch or close the user's Chrome.
  }
}

async function main(): Promise<void> {
  console.log = (...args: unknown[]) => console.error(...args);
  const controller = new AbortController();
  for (const s of ["SIGTERM", "SIGINT"] as const) process.on(s, () => controller.abort());
  let raw = ""; for await (const chunk of process.stdin) { raw += String(chunk); if (raw.length > 1_000_000) throw new Error("Input too large"); }
  const job = JSON.parse(raw) as PageJob;
  const timer = setTimeout(() => controller.abort(), job.timeoutMs);
  try { const result = await pageJob(job, controller.signal); process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`); }
  catch (e) { process.stdout.write(`${JSON.stringify({ ok: false, error: { code: controller.signal.aborted ? "cancelled" : e instanceof BrowserError ? e.code : "adapter", reason: e instanceof BrowserError ? e.reason : "Browser adapter could not finish. Inspect the run before any retry." } })}\n`); }
  finally { clearTimeout(timer); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch(() => { process.exitCode = 2; });
