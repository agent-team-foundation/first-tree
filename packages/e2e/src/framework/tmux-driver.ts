import { spawn, spawnSync } from "node:child_process";

/**
 * Test-side helpers for inspecting and seeding tmux state during TUI e2e.
 *
 * The handler under test (packages/client/src/handlers/claude-code-tui/) owns
 * its own tmux helpers (`tmux-session.ts`); this module is the QA side of the
 * fence — it observes what the handler created, plants pre-existing sessions
 * for orphan-sweep tests, kills sessions the handler leaked, and waits for
 * state transitions in the running fake.
 *
 * Why a parallel surface rather than importing the handler's helpers: tests
 * must remain trustworthy regardless of handler bugs. If a handler refactor
 * accidentally renames `listOwnedSessions`, the tests should still be able
 * to drive tmux directly to assert the buggy behaviour.
 */

export type TmuxRunResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
};

const DEFAULT_TIMEOUT_MS = 5000;

function runTmuxSync(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): TmuxRunResult {
  const res = spawnSync("tmux", args, { encoding: "utf-8", timeout: timeoutMs });
  return {
    ok: res.status === 0,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? (res.error ? res.error.message : ""),
    code: res.status,
  };
}

function runTmux(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<TmuxRunResult> {
  return new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("tmux", args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveResult({ ok: false, stdout, stderr: `${stderr}\n[timeout]`, code: null });
    }, timeoutMs);
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString("utf-8");
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString("utf-8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveResult({ ok: false, stdout, stderr: stderr + err.message, code: null });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveResult({ ok: code === 0, stdout, stderr, code });
    });
  });
}

/** True iff `tmux -V` succeeds, indicating the binary is usable. */
export function tmuxAvailable(): boolean {
  return runTmuxSync(["-V"]).ok;
}

/** List every tmux session name on the local server. `[]` if no server. */
export async function listAllSessions(): Promise<string[]> {
  const res = await runTmux(["list-sessions", "-F", "#{session_name}"]);
  if (!res.ok) return [];
  return res.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Sessions whose names start with `prefix`. */
export async function listSessionsByPrefix(prefix: string): Promise<string[]> {
  const all = await listAllSessions();
  return all.filter((name) => name.startsWith(prefix));
}

/** True iff a session with the exact name exists. */
export async function hasSession(name: string): Promise<boolean> {
  const res = await runTmux(["has-session", "-t", name]);
  return res.ok;
}

/** Best-effort kill (no throw if absent). */
export async function killSession(name: string): Promise<void> {
  await runTmux(["kill-session", "-t", name]);
}

/** Best-effort kill every session whose name starts with `prefix`. */
export async function killSessionsByPrefix(prefix: string): Promise<number> {
  const sessions = await listSessionsByPrefix(prefix);
  for (const s of sessions) {
    await killSession(s);
  }
  return sessions.length;
}

export type PlantSessionInput = {
  name: string;
  cwd: string;
  /** Command to run inside the planted session; defaults to a sleep so it stays alive. */
  command?: string;
};

/**
 * Plant a tmux session under a known name (used by orphan-sweep tests to
 * pre-seed sessions the handler should kill on startup). The default command
 * is a long sleep so the session survives until killed.
 */
export async function plantSession(input: PlantSessionInput): Promise<void> {
  const cmd = input.command ?? "sleep 3600";
  const args = ["new-session", "-d", "-s", input.name, "-c", input.cwd, cmd];
  const res = await runTmux(args);
  if (!res.ok) {
    throw new Error(`tmux new-session ${input.name} failed (code=${res.code ?? "n/a"}): ${res.stderr.trim()}`);
  }
}

/** Capture the visible pane content of a session, or "" if it doesn't exist. */
export async function capturePane(name: string): Promise<string> {
  const res = await runTmux(["capture-pane", "-t", name, "-p"]);
  return res.ok ? res.stdout : "";
}

export type WaitForSessionInput = {
  name: string;
  timeoutMs?: number;
  intervalMs?: number;
};

/** Poll until a session with the exact name appears (e.g. handler created it). */
export async function waitForSession(input: WaitForSessionInput): Promise<void> {
  const timeout = input.timeoutMs ?? 15_000;
  const interval = input.intervalMs ?? 100;
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await hasSession(input.name)) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  // Dump what this process CAN see so a name/prefix mismatch is diagnosable
  // instead of a bare timeout (the handler may have created the session under
  // a different tag, or this process may be on a different tmux server).
  const visible = await listAllSessions();
  throw new Error(
    `tmux session ${input.name} never appeared within ${timeout}ms. ` +
      `Sessions visible to this process: ${visible.length ? visible.join(", ") : "(none)"}`,
  );
}

export type WaitForSessionGoneInput = WaitForSessionInput;

/** Poll until the session no longer exists (e.g. handler tore it down). */
export async function waitForSessionGone(input: WaitForSessionGoneInput): Promise<void> {
  const timeout = input.timeoutMs ?? 15_000;
  const interval = input.intervalMs ?? 100;
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (!(await hasSession(input.name))) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`tmux session ${input.name} did not disappear within ${timeout}ms`);
}

/** List tmux buffer names on the local server, or `[]` if none / no server. */
export async function listBuffers(): Promise<string[]> {
  const res = await runTmux(["list-buffers", "-F", "#{buffer_name}"]);
  if (!res.ok) return [];
  return res.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
