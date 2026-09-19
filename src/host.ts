// Node process and filesystem boundaries. Browser policy lives in runtime.ts.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserError } from "./contracts.js";

export const packageRoot = fileURLToPath(new URL("../", import.meta.url));
export const home = () => path.resolve(process.env.FASTEST_E2E_HOME ?? path.join(os.homedir(), ".fastest-e2e"));
export interface Configuration { version: 1; chromeExecutable: string; profileDir: string }
export interface Session { browserId: string; wsUrl: string; namespace: string; profileDir: string }

export async function configuration(): Promise<Configuration> {
  let value: unknown;
  try { value = JSON.parse(await fs.readFile(path.join(home(), "config.json"), "utf8")); }
  catch { throw new BrowserError({ code: "setup", reason: "Run fastest-e2e init first. Configuration is missing or invalid." }); }
  const config = value as Partial<Configuration> | null;
  if (config?.version !== 1 || typeof config.chromeExecutable !== "string" ||
      typeof config.profileDir !== "string" || !path.isAbsolute(config.profileDir)) {
    throw new BrowserError({ code: "setup", reason: "Invalid config.json. Expected version 1 and an absolute profileDir." });
  }
  return config as Configuration;
}

export async function findChrome(): Promise<string> {
  const candidates = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
    : process.platform === "win32"
    ? [path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google/Chrome/Application/chrome.exe"),
       path.join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe")]
    : (process.env.PATH ?? "").split(path.delimiter).flatMap(dir =>
        ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].map(name => path.join(dir, name)));
  for (const candidate of candidates) {
    try { await fs.access(candidate, constants.X_OK); return candidate; } catch { /* Try the next executable. */ }
  }
  throw new BrowserError({ code: "setup", reason: "Chrome was not found. Pass --chrome with an absolute executable path." });
}

export async function initialize(chrome?: string, profile?: string): Promise<Configuration> {
  await fs.mkdir(home(), { recursive: true, mode: 0o700 });
  try { await fs.access(path.join(home(), "config.json")); return await configuration(); }
  catch (error) { if (error instanceof BrowserError) throw error; }
  const profileDir = path.resolve(profile ?? path.join(home(), "chrome"));
  const personalRoots = [
    path.join(os.homedir(), "Library/Application Support/Google/Chrome"),
    path.join(os.homedir(), ".config/google-chrome"),
    path.join(os.homedir(), ".config/chromium"),
    path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData/Local"), "Google/Chrome/User Data"),
  ];
  await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
  const resolved = await fs.realpath(profileDir);
  for (const root of personalRoots) {
    const realRoot = await fs.realpath(root).catch(() => path.resolve(root));
    const relative = path.relative(realRoot, resolved);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      throw new BrowserError({ code: "profile", reason: "Use a dedicated user-data directory outside personal Chrome storage." });
    }
  }
  const config: Configuration = { version: 1, chromeExecutable: chrome ? path.resolve(chrome) : await findChrome(), profileDir: resolved };
  await fs.writeFile(path.join(home(), "config.json"), `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return config;
}

export function parseActivePort(contents: string): { port: number; browserPath: string } {
  const [portText, browserPath] = contents.trim().split(/\r?\n/);
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !browserPath ||
      !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(browserPath)) {
    throw new BrowserError({ code: "session", reason: "Invalid DevToolsActivePort in the configured profile." });
  }
  return { port, browserPath };
}

export function assertEndpoint(value: unknown, port: number, browserPath: string): void {
  if (typeof value !== "string") throw new BrowserError({ code: "session", reason: "Chrome did not identify its debugging endpoint." });
  const url = new URL(value);
  if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || Number(url.port) !== port ||
      url.pathname !== browserPath || url.username || url.password || url.search || url.hash) {
    throw new BrowserError({ code: "session", reason: "The endpoint does not match the configured Chrome instance. No fallback was attempted." });
  }
}

export async function connect(): Promise<Session> {
  const config = await configuration();
  const profileDir = await fs.realpath(config.profileDir);
  let active: string;
  try { active = await fs.readFile(path.join(profileDir, "DevToolsActivePort"), "utf8"); }
  catch { throw new BrowserError({ code: "session", reason: "Configured Chrome is not connected. Run fastest-e2e start." }); }
  const { port, browserPath } = parseActivePort(active);
  let metadata: { webSocketDebuggerUrl?: unknown };
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { redirect: "error", signal: AbortSignal.timeout(2_000) });
    if (!response.ok) throw new Error("unavailable");
    metadata = await response.json() as { webSocketDebuggerUrl?: unknown };
  } catch { throw new BrowserError({ code: "session", reason: "Configured Chrome is unavailable. No other browser was selected." }); }
  assertEndpoint(metadata.webSocketDebuggerUrl, port, browserPath);
  const browserId = browserPath.split("/").at(-1)!;
  const namespace = createHash("sha256").update(`${profileDir}\0${browserPath}`).digest("hex").slice(0, 20);
  return { browserId, wsUrl: `ws://127.0.0.1:${port}${browserPath}`, namespace, profileDir };
}

export function workerEnvironment(session: Session, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...parent };
  for (const name of Object.keys(env)) {
    if (/^(BU_|BH_|BROWSER_HARNESS|BROWSER_USE|FASTEST_E2E_(TARGET|BROWSER))/.test(name)) delete env[name];
  }
  const harnessHome = path.join(home(), "harness", session.namespace);
  return {
    ...env,
    BU_CDP_WS: session.wsUrl,
    BU_NAME: `fe2e-${session.namespace}`,
    BH_HOME: harnessHome,
    BROWSER_HARNESS_HOME: harnessHome,
    BH_AGENT_WORKSPACE: path.join(harnessHome, "workspace"),
    BH_RECORD: "0",
    BH_TAB_MARKER: "0",
    BH_DOMAIN_SKILLS: "0",
    FASTEST_E2E_BROWSER_ID: session.browserId,
    FASTEST_E2E_TARGET_DIR: path.join(home(), "targets", session.namespace),
    PYTHONUNBUFFERED: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  };
}

export async function acquireLock(): Promise<() => Promise<void>> {
  await fs.mkdir(home(), { recursive: true, mode: 0o700 });
  const lockPath = path.join(home(), "session.lock");
  const token = randomUUID();
  let handle;
  try { handle = await fs.open(lockPath, "wx", 0o600); }
  catch { throw new BrowserError({ code: "busy", reason: `Session is locked. If a previous process crashed, verify it stopped before removing ${lockPath}.` }); }
  await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
  await handle.close();
  return async () => {
    const owner = JSON.parse(await fs.readFile(lockPath, "utf8")) as { token: string };
    if (owner.token === token) await fs.unlink(lockPath);
  };
}

export async function startChrome(headed: boolean): Promise<Session & { reused: boolean }> {
  try { return { ...await connect(), reused: true }; }
  catch (error) {
    if (error instanceof BrowserError && error.reason.includes("does not match")) throw error;
  }
  const config = await configuration();
  const log = await fs.open(path.join(home(), "chrome.log"), "a", 0o600);
  const child = spawn(config.chromeExecutable, [
    `--user-data-dir=${config.profileDir}`, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
    "--no-first-run", "--no-default-browser-check", "--window-size=1280,800",
    ...(headed ? [] : ["--headless=new"]), "about:blank",
  ], { detached: true, stdio: ["ignore", log.fd, log.fd], windowsHide: !headed });
  let spawnError: Error | undefined;
  child.once("error", error => { spawnError = error; });
  child.unref();
  await log.close();
  for (let i = 0; i < 80; i++) {
    if (spawnError || child.exitCode !== null) break;
    try { return { ...await connect(), reused: false }; } catch { /* Wait for this profile's endpoint. */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  if (child.exitCode === null && child.pid) child.kill("SIGTERM");
  throw new BrowserError({ code: "chrome", reason: "Chrome did not start. Inspect chrome.log in FASTEST_E2E_HOME; no other profile was used." });
}

export const pythonExecutable = () => path.join(home(), "worker-venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
