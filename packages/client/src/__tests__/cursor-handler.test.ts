import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { parseProviderRetryEventMessage, type SessionEvent } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionContext, SessionMessage, TurnOutcome } from "../runtime/handler.js";
import { mockCtxPlumbing } from "./test-helpers.js";

/**
 * Deterministic handler tests for the child-process teardown + first-turn
 * disposition. The child-process registry is mocked so no real process is
 * spawned — a scripted fake child drives stdout/stderr/exit, and SIGTERM can be
 * ignored on demand to exercise the SIGTERM→SIGKILL escalation.
 */

type FakeMode = "auth" | "success" | "ignore-term";

type FakeChildController = {
  child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: Writable };
  record: {
    pid: number;
    category: string;
    label: string;
    startedAt: number;
    kill: (signal?: string) => void;
    exited: Promise<void>;
  };
  isAlive: boolean;
  signals: string[];
};

const fakeState = vi.hoisted(() => ({
  mode: "success" as FakeMode,
  children: [] as unknown[],
}));

const INIT_LINE = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "sess-real-abc",
  model: "Composer 2.5",
});
const RESULT_LINE = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "done",
  session_id: "sess-real-abc",
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
});
const AUTH_STDERR =
  "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.\n";

function makeFakeChild(category: string, label: string): FakeChildController {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  const child = Object.assign(new EventEmitter(), { stdout, stderr, stdin });
  let resolveExited: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  let done = false;
  const signals: string[] = [];
  const finish = (code: number, signal: string | null): void => {
    if (done) return;
    done = true;
    controller.isAlive = false;
    stdout.end();
    stderr.end();
    child.emit("exit", code, signal);
    resolveExited();
  };
  // SIGTERM is ignored in "ignore-term" mode; SIGKILL always terminates.
  const kill = (signal?: string): void => {
    const sig = signal ?? "SIGTERM";
    signals.push(sig);
    if (sig === "SIGKILL") {
      finish(137, "SIGKILL");
      return;
    }
    if (fakeState.mode !== "ignore-term") finish(0, "SIGTERM");
  };
  const controller: FakeChildController = {
    child,
    record: { pid: 4321, category, label, startedAt: Date.now(), kill, exited },
    isAlive: true,
    signals,
  };
  // Drive the scripted stream/exit on the next tick.
  setImmediate(() => {
    if (fakeState.mode === "auth") {
      stderr.write(AUTH_STDERR);
      finish(1, null);
    } else if (fakeState.mode === "success") {
      stdout.write(`${INIT_LINE}\n`);
      stdout.write(`${RESULT_LINE}\n`);
      finish(0, null);
    } else {
      // ignore-term: emit init and stay alive until SIGKILL.
      stdout.write(`${INIT_LINE}\n`);
    }
  });
  return controller;
}

vi.mock("../runtime/child-process-registry.js", () => ({
  _resetChildProcessRegistryForTests: () => {
    fakeState.children.length = 0;
  },
  getChildProcessRegistry: () => ({
    spawn: (_command: string, _args: readonly string[], opts: { category: string; label: string }) => {
      const controller = makeFakeChild(opts.category, opts.label);
      fakeState.children.push(controller);
      return { child: controller.child, record: controller.record };
    },
    list: (filter?: { category?: string }) =>
      (fakeState.children as FakeChildController[])
        .filter((c) => c.isAlive && (!filter?.category || c.record.category === filter.category))
        .map((c) => c.record),
    adopt: () => {
      throw new Error("adopt not used in cursor handler tests");
    },
    unregister: () => {},
    killAll: async () => {},
  }),
}));

vi.mock("../runtime/cursor-binary.js", () => ({
  findCursorExecutableOnPath: () => "/fake/agent",
  formatCursorBinaryMissingMessage: (input: unknown) => `missing: ${String(input)}`,
}));
vi.mock("../runtime/agent-bootstrap.js", () => ({ ensureAgentBootstrap: vi.fn() }));
vi.mock("../runtime/agent-briefing.js", () => ({ buildAgentBriefing: () => "briefing" }));
vi.mock("../runtime/resource-skills.js", () => ({ materializeResourceSkills: vi.fn(async () => {}) }));
vi.mock("../runtime/workspace.js", () => ({
  acquireAgentHome: (root: string) => root,
  markWorkspaceInitComplete: vi.fn(),
}));
vi.mock("../runtime/session-briefing-fingerprint.js", () => ({
  buildBriefingUpdateNotice: () => "re-read notice",
  computeBriefingFingerprint: () => "fp",
  readSessionBriefingFingerprint: () => null,
  writeSessionBriefingFingerprint: vi.fn(),
}));
vi.mock("../runtime/chat-context.js", () => ({
  fetchChatContext: vi.fn(async () => {
    throw new Error("no chat context in test");
  }),
}));

import { createCursorHandler } from "../handlers/cursor/index.js";

const AGENT_ID = "019e71c9-88d2-70be-be67-fdb033b2ef0b";
let workspaceRoot: string;

type CtxCapture = {
  events: SessionEvent[];
  finishOutcomes: TurnOutcome[];
  retryReasons: string[];
};

function makeContext(capture: CtxCapture): SessionContext {
  const sendMessage = vi.fn(async () => undefined);
  return {
    agent: {
      agentId: AGENT_ID,
      inboxId: `inbox_${AGENT_ID}`,
      displayName: "cursor-assistant",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: { serverUrl: "http://test", sendMessage } as unknown as SessionContext["sdk"],
    chatId: "chat-cursor",
    log: () => {},
    recordProviderActivity: () => {},
    emitEvent: (event) => capture.events.push(event),
    ...mockCtxPlumbing({ sendMessage }, "chat-cursor"),
    finishTurn: async (_messages, outcome) => {
      capture.finishOutcomes.push(outcome);
    },
    retryTurn: (_messages, reason) => {
      capture.retryReasons.push(reason);
    },
    replaceSessionId: () => {},
  };
}

function makeMessage(content: string): SessionMessage {
  return { id: "msg-1", chatId: "chat-cursor", senderId: "sender-1", format: "text", content, metadata: {} };
}

function newCapture(): CtxCapture {
  return { events: [], finishOutcomes: [], retryReasons: [] };
}

function structuredTerminalEvent(events: SessionEvent[]): ReturnType<typeof parseProviderRetryEventMessage> {
  for (const event of events) {
    if (event.kind !== "error") continue;
    const payload = parseProviderRetryEventMessage(event.payload.message);
    if (payload) return payload;
  }
  return null;
}

async function waitFor(assertion: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!assertion()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for assertion");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ft-cursor-handler-"));
  fakeState.children.length = 0;
  fakeState.mode = "success";
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("cursor handler — first-turn disposition (finding 2)", () => {
  it("a successful first turn returns the cursor-minted session id", async () => {
    fakeState.mode = "success";
    const capture = newCapture();
    const handler = createCursorHandler({ workspaceRoot, runtimeProvider: "cursor" });
    const result = await handler.start(makeMessage("hi"), makeContext(capture));
    const sessionId = typeof result === "string" ? result : result.sessionId;
    expect(sessionId).toBe("sess-real-abc");
    expect(capture.finishOutcomes.at(-1)?.status).toBe("success");
    await handler.shutdown();
  });

  it("a pre-init auth failure returns a synthetic id instead of throwing (no double-handle)", async () => {
    fakeState.mode = "auth";
    const capture = newCapture();
    const handler = createCursorHandler({ workspaceRoot, runtimeProvider: "cursor" });

    // Must NOT throw even though no session id was minted before the exit.
    const result = await handler.start(makeMessage("hi"), makeContext(capture));
    const sessionId = typeof result === "string" ? result : result.sessionId;
    expect(sessionId.startsWith("cursor-pending-")).toBe(true);

    // The delivery was settled EXACTLY once, as a terminal consumed error — the
    // turn's disposition is authoritative; start() does not also reject it.
    expect(capture.retryReasons).toHaveLength(0);
    expect(capture.finishOutcomes).toHaveLength(1);
    expect(capture.finishOutcomes[0]).toMatchObject({ terminal: true, completion: "consumed" });

    // Plus the structured terminal event that drives the durable chat notice (finding 3).
    const terminal = structuredTerminalEvent(capture.events);
    expect(terminal?.event).toBe("provider_failure_terminal");
    expect(terminal?.category).toBe("credential");
    await handler.shutdown();
  });
});

describe("cursor handler — bounded teardown escalation (finding 4)", () => {
  it("shutdown escalates SIGTERM→SIGKILL and never hangs on a child that ignores SIGTERM", async () => {
    fakeState.mode = "ignore-term";
    const capture = newCapture();
    const handler = createCursorHandler({
      workspaceRoot,
      runtimeProvider: "cursor",
      // Short escalation windows so the test exercises SIGKILL quickly.
      cursorKillTerminateGraceMs: 120,
      cursorKillFinalWaitMs: 120,
    });

    // The child stays alive (ignoring SIGTERM), so start() stays pending.
    const startPromise = handler.start(makeMessage("hi"), makeContext(capture));
    await waitFor(() => (fakeState.children as FakeChildController[]).some((c) => c.isAlive));
    const controller = (fakeState.children as FakeChildController[])[0];

    const startedAt = Date.now();
    await handler.shutdown();
    const elapsed = Date.now() - startedAt;

    // Resolved (did not hang) and waited the grace before SIGKILL (SIGTERM ignored).
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(2000);
    // Escalation actually happened: both signals were sent, in order.
    expect(controller?.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(controller?.isAlive).toBe(false);
    // The aborted turn was left recoverable (retry), not falsely completed.
    await startPromise;
    expect(capture.retryReasons).toContain("cursor_turn_aborted");
  });
});
