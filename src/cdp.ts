// A small CDP transport for identity/observation. UI actions stay in upstream adapters.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Session } from "./host.js";
import { BrowserError } from "./contracts.js";
import type { Checkpoint } from "./journal.js";

type Message = { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown; sessionId?: string };
export class Cdp {
  private next = 0;
  private pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(m: Message) => void>();
  private constructor(readonly socket: WebSocket) {
    socket.addEventListener("message", event => {
      let m: Message; try { m = JSON.parse(String(event.data)) as Message; } catch { return; }
      if (m.id !== undefined) {
        const p = this.pending.get(m.id); if (!p) return;
        this.pending.delete(m.id); clearTimeout(p.timer);
        if (m.error) p.reject(new BrowserError({ code: "browser", reason: m.error.message })); else p.resolve(m.result);
      } else for (const listener of this.listeners) listener(m);
    });
    socket.addEventListener("close", () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new BrowserError({ code: "session_changed", reason: "Chrome disconnected; no other browser was selected." })); }
      this.pending.clear();
    });
  }
  static async open(session: Session): Promise<Cdp> {
    const ws = new WebSocket(session.wsUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new BrowserError({ code: "session", reason: "CDP connection timed out." })); }, 3_000);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new BrowserError({ code: "session", reason: "Configured CDP endpoint is unavailable." })); }, { once: true });
    });
    return new Cdp(ws);
  }
  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) { reject(new BrowserError({ code: "session_changed", reason: "CDP connection is closed." })); return; }
      const id = ++this.next;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new BrowserError({ code: "browser_timeout", reason: `${method} did not finish; do not assume an action failed.` })); }, 8_000);
      this.pending.set(id, { resolve: r => resolve(r as T), reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(listener: (m: Message) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async close(): Promise<void> { this.socket.close(); }
  async attach(targetId: string): Promise<string> {
    const { sessionId } = await this.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }); return sessionId;
  }
  async evaluate<T>(sessionId: string, expression: string): Promise<T> {
    const r = await this.send<{ result: { value?: T }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new BrowserError({ code: "observation", reason: "The document changed or could not be inspected." });
    return r.result.value as T;
  }
}

// Only the fingerprint is persisted. Password, OTP, and file values are never read.
export const liveStateExpression = readFileSync(new URL("../worker/live-state.js", import.meta.url), "utf8").trim();
export async function checkpoint(cdp: Cdp, sessionId: string): Promise<Checkpoint> {
  const [tree, live] = await Promise.all([
    cdp.send<{ frameTree: unknown }>("Page.getFrameTree", {}, sessionId),
    cdp.evaluate<string>(sessionId, `JSON.stringify(${liveStateExpression})`),
  ]);
  const identities = (t: unknown): unknown => {
    const node = t as { frame: { id: string; loaderId: string }; childFrames?: unknown[] };
    return [node.frame.id, node.frame.loaderId, ...(node.childFrames ?? []).map(identities)];
  };
  const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
  return { documentId: hash(identities(tree.frameTree)), fingerprint: createHash("sha256").update(live).digest("hex"), url: (JSON.parse(live) as {url: string}).url, at: Date.now() };
}
export function sameDocument(a: Checkpoint | undefined, b: Checkpoint): boolean { return !!a && a.documentId === b.documentId; }
