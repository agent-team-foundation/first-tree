import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type CurrentRunHandle, readCredentialsOrThrow } from "./current-handle.js";
import { PACKAGE_E2E_ROOT } from "./env.js";
import { FakeTuiLogReader } from "./fake-tui-log.js";

/**
 * Fixture for tests that need a real `claude-code-tui` agent running against
 * the e2e world's daemon. The fixture creates the agent + chat via the public
 * API (matching how a user would set this up through the web UI), wires the
 * per-agent fake-tui log path via the runtime payload's env, and exposes
 * helpers for sending messages, reading replies from PG, and asserting on
 * the fake's recorded timeline.
 *
 * The daemon process itself must already be running with the fake binary on
 * `CLAUDE_CODE_EXECUTABLE` — `startTuiRunWorld()` handles that bootstrap.
 *
 * Why per-agent FAKE_TUI_LOG_PATH (instead of one process-wide log) — every
 * TUI handler instance reads the same env at spawn time and writes events
 * tagged with its session id. With one shared log path, two parallel agents
 * would interleave events in a single file and tests would have to filter by
 * session id. Per-agent paths keep assertions trivial: `reader.byKind(...)`
 * returns only this agent's events.
 */

export const FAKE_CLAUDE_TUI_EXECUTABLE = resolve(PACKAGE_E2E_ROOT, "src/mocks/fake-claude-tui.mjs");

export type FakeTuiAgentKnobs = {
  /** Canned reply override (FAKE_TUI_REPLY). */
  reply?: string;
  /** Delay before advertising ready (FAKE_TUI_READY_DELAY_MS). */
  readyDelayMs?: number;
  /** Pre-emit delay (FAKE_TUI_DELAY_MS). */
  delayMs?: number;
  /** Never paint the ready marker (FAKE_TUI_FAIL_READY=1). */
  failReady?: boolean;
  /** Receive input then never finish (FAKE_TUI_HANG=1). Probes turn timeout. */
  hang?: boolean;
  /** Exit non-zero after N completed turns (FAKE_TUI_CRASH_AFTER_TURNS). */
  crashAfterTurns?: number;
  /** First turn emits a Bash tool_use (FAKE_TUI_TOOL_CALL=1). */
  emitToolCall?: boolean;
};

export type CreateTuiAgentInput = {
  /** The current e2e run handle (from `readCurrentHandle()`). */
  handle: CurrentRunHandle;
  /** Display label for the agent (optional; auto-generated when omitted). */
  displayName?: string;
  /** Behaviour knobs forwarded to the fake-tui binary via per-agent env. */
  knobs?: FakeTuiAgentKnobs;
  /**
   * Real-provider parity uses the product path: create the agent already bound
   * to the client. Fake TUI tests can opt into patching env first so the first
   * pinned-frame config load cannot miss fake-only knobs like readyDelayMs.
   */
  bindMode?: "at-create" | "after-env-patch";
  /** Optional override of where the fake-tui side-channel log lands. */
  logPath?: string;
};

export type TuiAgentFixture = {
  /** Server-side agent uuid. */
  agentId: string;
  /** Server-side agent name (lowercase). */
  agentName: string;
  /** Server-side chat the human user shares with this agent. */
  chatId: string;
  /** Reader for the side-channel log the fake-tui binary writes. */
  fakeLog: FakeTuiLogReader;
  /** Per-agent env knobs that were applied (echoed for diagnostics). */
  knobs: FakeTuiAgentKnobs;
  /** Absolute path of the log file the fake writes. */
  logPath: string;
};

const E2E_RUNS_DIR = resolve(PACKAGE_E2E_ROOT, ".e2e-runs");

/**
 * Helper: deterministic per-agent FAKE_TUI_LOG_PATH under `.e2e-runs/`.
 * Tests don't usually pass `logPath`; the default keeps every fixture's log
 * isolated under the current run id.
 */
function defaultLogPath(handle: CurrentRunHandle, agentName: string): string {
  return join(E2E_RUNS_DIR, "fake-tui-logs", handle.runId, `${agentName}.jsonl`);
}

/**
 * Translate the knobs into the env block the runtime payload carries. The
 * handler's `buildEnv()` copies these into the spawned tmux command so the
 * fake binary sees them at startup.
 */
function knobsToEnvEntries(knobs: FakeTuiAgentKnobs, logPath: string): Array<{ key: string; value: string }> {
  const env: Array<{ key: string; value: string }> = [];
  env.push({ key: "FAKE_TUI_LOG_PATH", value: logPath });
  if (knobs.reply !== undefined) env.push({ key: "FAKE_TUI_REPLY", value: knobs.reply });
  if (knobs.readyDelayMs !== undefined) env.push({ key: "FAKE_TUI_READY_DELAY_MS", value: String(knobs.readyDelayMs) });
  if (knobs.delayMs !== undefined) env.push({ key: "FAKE_TUI_DELAY_MS", value: String(knobs.delayMs) });
  if (knobs.failReady) env.push({ key: "FAKE_TUI_FAIL_READY", value: "1" });
  if (knobs.hang) env.push({ key: "FAKE_TUI_HANG", value: "1" });
  if (knobs.crashAfterTurns !== undefined && knobs.crashAfterTurns > 0) {
    env.push({ key: "FAKE_TUI_CRASH_AFTER_TURNS", value: String(knobs.crashAfterTurns) });
  }
  if (knobs.emitToolCall) env.push({ key: "FAKE_TUI_TOOL_CALL", value: "1" });
  return env;
}

/**
 * Create a `claude-code-tui` agent + bound chat in the active e2e world.
 * Assumes the daemon was spawned with `CLAUDE_CODE_EXECUTABLE` pointing at
 * the fake binary (see `startTuiRunWorld` in `lifecycle.ts`).
 */
export async function createTuiAgent(input: CreateTuiAgentInput): Promise<TuiAgentFixture> {
  const creds = readCredentialsOrThrow(input.handle);
  const knobs = input.knobs ?? {};
  const bindMode = input.bindMode ?? "at-create";
  const agentName = `tui-${randomBytes(3).toString("hex")}`;
  const logPath = input.logPath ?? defaultLogPath(input.handle, agentName);
  mkdirSync(dirname(logPath), { recursive: true });

  // The server's agent-create endpoint enforces a per-user rate limit; eight
  // TUI scenarios' beforeAll fires within seconds and the bucket trips. Honor
  // the `Retry-After`-style hint embedded in the 429 body and retry up to a
  // minute. Other 4xx are surfaced immediately.
  const createBody = JSON.stringify({
    name: agentName,
    type: "agent",
    displayName: input.displayName ?? `TUI fixture ${agentName}`,
    ...(bindMode === "at-create" ? { clientId: creds.clientId } : {}),
    runtimeProvider: "claude-code-tui",
  });
  let created: { uuid: string } | null = null;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const createRes = await fetch(`${input.handle.serverBaseUrl}/api/v1/orgs/${creds.organizationId}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.accessToken}` },
      body: createBody,
    });
    if (createRes.status === 201) {
      created = (await createRes.json()) as { uuid: string };
      break;
    }
    if (createRes.status === 429) {
      const text = await createRes.text();
      const retrySeconds = Number(text.match(/retry in (\d+) seconds/)?.[1] ?? "5");
      // Cap the wait so a stuck bucket can't hang the run; the outer deadline
      // is the real ceiling.
      await new Promise((r) => setTimeout(r, Math.min(retrySeconds * 1000 + 250, 15_000)));
      continue;
    }
    throw new Error(`create tui agent ${agentName} failed: ${createRes.status} ${await createRes.text()}`);
  }
  if (!created) {
    throw new Error(`create tui agent ${agentName} kept hitting 429 for 90s — server rate limit didn't recover`);
  }

  // Push per-agent env onto the agent's runtime config payload via PATCH.
  // The daemon refreshes the agent config cache on the next session start,
  // and the handler's buildEnv() merges payload.env into the spawn env.
  await patchAgentRuntimeEnv({
    handle: input.handle,
    accessToken: creds.accessToken,
    agentId: created.uuid,
    envEntries: knobsToEnvEntries(knobs, logPath),
  });
  if (bindMode === "after-env-patch") {
    await bindAgentToClient({
      handle: input.handle,
      accessToken: creds.accessToken,
      agentId: created.uuid,
      clientId: creds.clientId,
    });
  }

  const chatRes = await fetch(`${input.handle.serverBaseUrl}/api/v1/orgs/${creds.organizationId}/chats`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.accessToken}` },
    body: JSON.stringify({ participantIds: [created.uuid] }),
  });
  if (chatRes.status !== 201) {
    throw new Error(`create chat for ${agentName} failed: ${chatRes.status} ${await chatRes.text()}`);
  }
  const chatBody = (await chatRes.json()) as { chatId: string };

  return {
    agentId: created.uuid,
    agentName,
    chatId: chatBody.chatId,
    fakeLog: new FakeTuiLogReader(logPath),
    knobs,
    logPath,
  };
}

/**
 * Send a user message to the TUI agent's chat (caller speaks as the fixture
 * human agent, resolved server-side from the user JWT).
 */
export async function sendUserMessageToTuiAgent(input: {
  handle: CurrentRunHandle;
  chatId: string;
  text: string;
  /** Agent uuid to @mention so the message actually wakes the runtime. */
  mentionAgentId: string;
}): Promise<{ id: string }> {
  const creds = readCredentialsOrThrow(input.handle);
  // Group-chat policy (see project memory `first-tree group chat mention
  // rule`): a send requires an explicit recipient — `metadata.mentions:
  // [agentId]` is the canonical way to address one specific agent. Without
  // it the server rejects with 400.
  const res = await fetch(`${input.handle.serverBaseUrl}/api/v1/chats/${input.chatId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.accessToken}` },
    body: JSON.stringify({
      format: "text",
      content: input.text,
      metadata: { mentions: [input.mentionAgentId] },
    }),
  });
  if (res.status !== 201) {
    throw new Error(`send user message failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as { id: string };
}

/**
 * Poll the chat's message list until at least one message satisfies the
 * predicate (default: any message from the agent that isn't the user's own).
 * Returns the matching messages so callers can assert on content.
 */
export async function waitForAgentReply(input: {
  handle: CurrentRunHandle;
  chatId: string;
  /** Message id of the user's send — we filter the agent's reply that came after. */
  afterMessageId?: string;
  /** Match predicate; default: any message whose senderId !== the human agent. */
  predicate?: (m: ChatMessage) => boolean;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<ChatMessage[]> {
  const creds = readCredentialsOrThrow(input.handle);
  const timeout = input.timeoutMs ?? 30_000;
  const interval = input.intervalMs ?? 200;
  const predicate = input.predicate ?? ((m) => m.senderId !== creds.humanAgentId);
  const started = Date.now();
  let lastBody: ChatMessage[] = [];
  while (Date.now() - started < timeout) {
    const res = await fetch(`${input.handle.serverBaseUrl}/api/v1/chats/${input.chatId}/messages`, {
      headers: { Authorization: `Bearer ${creds.accessToken}` },
    });
    if (res.status === 200) {
      const body = (await res.json()) as { items: ChatMessage[] };
      lastBody = body.items;
      const candidates = body.items
        .filter((m) => (input.afterMessageId ? m.id !== input.afterMessageId : true))
        .filter(predicate);
      if (candidates.length > 0) return candidates;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(
    `waitForAgentReply timed out after ${timeout}ms (chatId=${input.chatId}). Last items: ` +
      JSON.stringify(lastBody.map((m) => ({ id: m.id, senderId: m.senderId, format: m.format }))),
  );
}

export type ChatMessage = {
  id: string;
  chatId: string;
  senderId: string;
  format: string;
  content: string;
  inReplyTo: string | null;
};

async function patchAgentRuntimeEnv(input: {
  handle: CurrentRunHandle;
  accessToken: string;
  agentId: string;
  envEntries: Array<{ key: string; value: string }>;
}): Promise<void> {
  // GET the current config, mutate the env block, PATCH with the expected
  // version. Two-step instead of one because the schema requires
  // `expectedVersion` for optimistic locking.
  const getRes = await fetch(`${input.handle.serverBaseUrl}/api/v1/agents/${input.agentId}/config`, {
    headers: { Authorization: `Bearer ${input.accessToken}` },
  });
  if (getRes.status !== 200) {
    throw new Error(`fetch runtime config failed: ${getRes.status} ${await getRes.text()}`);
  }
  const cfg = (await getRes.json()) as {
    version: number;
    payload: { env: Array<{ key: string; value: string }> } & Record<string, unknown>;
  };

  // Replace any existing entries with the same key, then append the rest.
  const desiredKeys = new Set(input.envEntries.map((e) => e.key));
  const next = cfg.payload.env.filter((e) => !desiredKeys.has(e.key)).concat(input.envEntries);

  const patchRes = await fetch(`${input.handle.serverBaseUrl}/api/v1/agents/${input.agentId}/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.accessToken}` },
    body: JSON.stringify({
      expectedVersion: cfg.version,
      payload: { env: next },
    }),
  });
  if (patchRes.status !== 200) {
    throw new Error(`patch runtime env failed: ${patchRes.status} ${await patchRes.text()}`);
  }
}

async function bindAgentToClient(input: {
  handle: CurrentRunHandle;
  accessToken: string;
  agentId: string;
  clientId: string;
}): Promise<void> {
  const res = await fetch(`${input.handle.serverBaseUrl}/api/v1/agents/${input.agentId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.accessToken}` },
    body: JSON.stringify({ clientId: input.clientId }),
  });
  if (res.status !== 200) {
    throw new Error(`bind tui agent to client failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Helper: derive the per-(agent, chat) tmux session name the handler will
 * pick. Mirrors `tmux-session.ts:deriveSessionName` exactly so tests can
 * assert on a session name without poking the handler internals.
 *
 * The digest separator is a literal NUL (`\0`), NOT a space — matching the
 * handler's `createHash("sha256").update(\`${agentId}\0${chatId}\`)`. Using a
 * space here silently produces a different digest (every derived name would
 * mismatch the real session); keep these byte-for-byte identical.
 */
export function expectedTuiSessionName(input: { clientTagSource: string; agentId: string; chatId: string }): string {
  const tag = clientTagFromId(input.clientTagSource);
  const digest = sha256Slice(`${input.agentId}\0${input.chatId}`, 12);
  return `ftth-${tag}-${digest}`;
}

/** Mirrors tmux-session.ts:ownedSessionPrefix. */
export function expectedTuiSessionPrefix(clientTagSource: string): string {
  return `ftth-${clientTagFromId(clientTagSource)}-`;
}

function clientTagFromId(clientId: string): string {
  const s = clientId.replace(/[^A-Za-z0-9_-]/g, "").toLowerCase();
  return s.length >= 4 ? s.slice(-8) : "nocid";
}

function sha256Slice(input: string, hexChars: number): string {
  return createHash("sha256").update(input).digest("hex").slice(0, hexChars);
}
