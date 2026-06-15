import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READY_MARKER, TMUX_SESSION_PREFIX, USER_RE } from "./tui-markers.js";

const DEFAULT_TMUX_TIMEOUT_MS = 5000;

type TmuxResult = { ok: boolean; stdout: string; stderr: string; code: number | null };

function runTmux(args: string[], timeoutMs = DEFAULT_TMUX_TIMEOUT_MS): Promise<TmuxResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn("tmux", args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        resolve({ ok: false, stdout, stderr: `${stderr}\n[timeout]`, code: null });
      }
    }, timeoutMs);
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString("utf-8");
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString("utf-8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: stderr + (stderr ? "\n" : "") + err.message, code: null });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, code });
    });
  });
}

async function tmuxOrThrow(args: string[], timeoutMs?: number): Promise<string> {
  const result = await runTmux(args, timeoutMs);
  if (!result.ok) {
    throw new Error(`tmux ${args.join(" ")} failed (code=${result.code ?? "n/a"}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

export type NewSessionInput = {
  name: string;
  cwd: string;
  command: string;
  env?: Record<string, string>;
  width?: number;
  height?: number;
};

/**
 * Spawn a detached tmux session running `command`. Returns once tmux reports
 * the session started (note: the inner process may still be initialising).
 */
export async function newSession(input: NewSessionInput): Promise<void> {
  const args = [
    "new-session",
    "-d",
    "-s",
    input.name,
    "-x",
    String(input.width ?? 220),
    "-y",
    String(input.height ?? 60),
    "-c",
    input.cwd,
  ];
  for (const [k, v] of Object.entries(input.env ?? {})) {
    args.push("-e", `${k}=${v}`);
  }
  args.push(input.command);
  await tmuxOrThrow(args);
}

/**
 * Inject text into the session pane via bracketed paste, then send Enter.
 *
 * `load-buffer` writes the verbatim text into a tmux buffer; `paste-buffer
 * -p` uses bracketed paste so multi-line content and shell metacharacters
 * (\ ` $ etc.) are delivered without interpretation. A small delay before
 * Enter avoids races where claude's reader misses the trailing newline.
 *
 * Cleanup matters for confidentiality: the tmux buffer lives on the shared
 * tmux *server*, not in our session, so even after our session is killed the
 * message text stays readable via `tmux show-buffer` from any other surviving
 * session. We delete the buffer (`paste-buffer -d` plus a finally backstop) and
 * remove the whole temp directory, not just the file.
 */
export async function pasteText(sessionName: string, text: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ftth-tui-"));
  const file = join(dir, "msg.txt");
  writeFileSync(file, text, "utf-8");
  const bufferName = `${sessionName}-msg`;
  try {
    await tmuxOrThrow(["load-buffer", "-b", bufferName, file]);
    // `-d` deletes the buffer once pasted, so the text doesn't linger server-side.
    await tmuxOrThrow(["paste-buffer", "-b", bufferName, "-t", sessionName, "-p", "-d"]);
    await new Promise((r) => setTimeout(r, 150));
    await tmuxOrThrow(["send-keys", "-t", sessionName, "Enter"]);
  } finally {
    // Backstop: if paste failed before `-d` could delete the buffer, drop it
    // explicitly. Best-effort (no throw if already gone).
    await runTmux(["delete-buffer", "-b", bufferName]);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Send a single key (e.g. `Escape`, `C-c`) to the session. */
export async function sendKey(sessionName: string, key: string): Promise<void> {
  await tmuxOrThrow(["send-keys", "-t", sessionName, key]);
}

/** Snapshot the visible pane (or full scrollback when `fullScrollback`). */
export async function capturePane(sessionName: string, fullScrollback = false): Promise<string> {
  const args = ["capture-pane", "-t", sessionName, "-p"];
  if (fullScrollback) args.push("-S", "-");
  return tmuxOrThrow(args);
}

/** True iff a tmux session with the given name exists. */
export async function sessionExists(sessionName: string): Promise<boolean> {
  const result = await runTmux(["has-session", "-t", sessionName]);
  return result.ok;
}

/** Force-kill the tmux session; best-effort (no throw if already gone). */
export async function killSession(sessionName: string): Promise<void> {
  await runTmux(["kill-session", "-t", sessionName]);
}

/** List names of all tmux sessions on the local server. Returns [] if no server is running. */
export async function listSessions(): Promise<string[]> {
  const result = await runTmux(["list-sessions", "-F", "#{session_name}"]);
  if (!result.ok) return [];
  return result.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * List sessions whose name starts with `prefix`. The orphan sweep passes the
 * client-scoped prefix from `ownedSessionPrefix(clientId)` so it only ever
 * matches sessions THIS client created — never another live client process or
 * a parallel QA slot, which carry a different client tag.
 */
export async function listOwnedSessions(prefix: string): Promise<string[]> {
  const all = await listSessions();
  return all.filter((name) => name.startsWith(prefix));
}

export type WaitForReadyInput = {
  name: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
};

/**
 * Claude Code 2.1.170 may show a one-time workspace trust dialog before the
 * normal TUI surface when a fresh agent workspace has never been opened by the
 * local user. First Tree creates and owns these agent workspaces; without
 * acknowledging this dialog the handler never reaches the ready marker.
 */
export function isWorkspaceTrustPrompt(pane: string): boolean {
  return (
    pane.includes("Quick safety check:") &&
    pane.includes("Yes, I trust this folder") &&
    pane.includes("Enter to confirm")
  );
}

/**
 * Poll capture-pane until both the bypass-permissions marker and a `❯`
 * input prompt line are visible. Resolves on success, throws on timeout.
 * If Claude shows its workspace trust prompt first, acknowledge it once and
 * keep waiting for the actual ready surface.
 */
export async function waitForReady(input: WaitForReadyInput): Promise<void> {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const pollIntervalMs = input.pollIntervalMs ?? 250;
  const started = Date.now();
  let acceptedWorkspaceTrust = false;
  while (Date.now() - started < timeoutMs) {
    const pane = await capturePane(input.name);
    if (!acceptedWorkspaceTrust && isWorkspaceTrustPrompt(pane)) {
      acceptedWorkspaceTrust = true;
      await sendKey(input.name, "Enter");
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      continue;
    }
    if (pane.includes(READY_MARKER) && pane.split("\n").some((line) => USER_RE.test(line))) {
      return;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`claude TUI did not become ready within ${timeoutMs}ms (session=${input.name})`);
}

/**
 * Per-client tag embedded in every session name so each client process owns a
 * disjoint slice of the `ftth-` namespace. Derived from the trailing chars of
 * the client id (the unique hex in `client_<hex>`); stable across restarts of
 * the same client (so the sweep finds its own crashed-run leftovers) but
 * distinct from any other client / QA process.
 */
function clientTag(clientId: string): string {
  const s = sanitise(clientId);
  return s.length >= 4 ? s.slice(-8) : "nocid";
}

/** Prefix matching exactly the sessions a given client owns: `ftth-<clientTag>-`. */
export function ownedSessionPrefix(clientId: string): string {
  return `${TMUX_SESSION_PREFIX}${clientTag(clientId)}-`;
}

/**
 * Derive a deterministic, tmux-safe, collision-resistant session name from
 * `(clientId, agentId, chatId)`.
 *
 * The agent/chat component is a hash, not a truncated prefix: server agent ids
 * are uuidv7, whose leading chars are a millisecond timestamp, so two agents
 * created close together share the first 8 chars. Truncating would alias two
 * distinct peer agents in the same chat to one session name — and `startClaude`
 * kills any pre-existing session with that name, so one agent would tear down a
 * peer's live pane. A 12-hex (48-bit) SHA-256 slice gives uniform entropy
 * regardless of uuid structure; collisions are negligible. The output is hex
 * only, so it is inherently tmux-safe (no `:`/`.`). The client-owner prefix is
 * kept so the orphan sweep's prefix filter still matches.
 */
export function deriveSessionName(clientId: string, agentId: string, chatId: string): string {
  const digest = createHash("sha256").update(`${agentId} ${chatId}`).digest("hex").slice(0, 12);
  return `${ownedSessionPrefix(clientId)}${digest}`;
}

function sanitise(input: string): string {
  return input.replace(/[^A-Za-z0-9_-]/g, "").toLowerCase();
}
