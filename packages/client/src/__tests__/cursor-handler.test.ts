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

type FakeMode = "auth" | "auth-late-stderr" | "success" | "success-empty" | "no-result" | "ignore-term" | "unkillable";

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
  /** Test-triggered terminal close (for the fence test's abandoned child). */
  forceClose: () => void;
};

const fakeState = vi.hoisted(() => ({
  mode: "success" as FakeMode,
  // Per-spawn mode override: modes[i] drives the i-th spawn, else `mode`.
  modes: [] as FakeMode[],
  children: [] as unknown[],
  spawns: [] as { command: string; args: string[] }[],
  // Resolved cursor binary path; null simulates an unresolvable binary (finding 3).
  binaryPath: "/fake/agent" as string | null,
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
const EMPTY_RESULT_LINE = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "",
  session_id: "sess-real-abc",
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
});

function makeFakeChild(category: string, label: string, mode: FakeMode): FakeChildController {
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
  let exitDone = false;
  let closeDone = false;
  const signals: string[] = [];
  // `close` fires only after ALL stdio has drained — the barrier the handler
  // now gates finalize on (finding 4).
  const emitClose = (code: number, signal: string | null): void => {
    if (closeDone) return;
    closeDone = true;
    controller.isAlive = false;
    child.emit("close", code, signal);
    resolveExited();
  };
  const emitExit = (code: number, signal: string | null): void => {
    if (exitDone) return;
    exitDone = true;
    child.emit("exit", code, signal);
  };
  // Simple termination: end stdio, then exit + close together.
  const finish = (code: number, signal: string | null): void => {
    stdout.end();
    stderr.end();
    emitExit(code, signal);
    emitClose(code, signal);
  };
  // SIGTERM is ignored in "ignore-term" mode; "unkillable" ignores BOTH signals
  // (only a test-triggered forceClose ends it) so a turn can outlive teardown.
  const kill = (signal?: string): void => {
    const sig = signal ?? "SIGTERM";
    signals.push(sig);
    if (mode === "unkillable") return;
    if (sig === "SIGKILL") {
      finish(137, "SIGKILL");
      return;
    }
    if (mode !== "ignore-term") finish(0, "SIGTERM");
  };
  const controller: FakeChildController = {
    child,
    record: { pid: 4321, category, label, startedAt: Date.now(), kill, exited },
    isAlive: true,
    signals,
    forceClose: () => finish(137, "SIGKILL"),
  };
  // Drive the scripted stream/exit on the next tick.
  setImmediate(() => {
    if (mode === "auth") {
      stderr.write(AUTH_STDERR);
      finish(1, null);
    } else if (mode === "auth-late-stderr") {
      // stdout closes first (empty), the process exits, and ONLY THEN does the
      // auth stderr arrive — before `close`. A barrier that settled on `exit`
      // would miss it and misclassify the failure as a generic retry.
      stdout.end();
      emitExit(1, null);
      setTimeout(() => {
        stderr.write(AUTH_STDERR);
        stderr.end();
        emitClose(1, null);
      }, 15);
    } else if (mode === "no-result") {
      // Generic crash: no stdout JSON, empty stderr, non-zero exit.
      finish(2, null);
    } else if (mode === "success" || mode === "success-empty") {
      stdout.write(`${INIT_LINE}\n`);
      stdout.write(`${mode === "success-empty" ? EMPTY_RESULT_LINE : RESULT_LINE}\n`);
      finish(0, null);
    } else {
      // ignore-term / unkillable: emit init and stay alive until killed/closed.
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
    spawn: (command: string, args: readonly string[], opts: { category: string; label: string }) => {
      const index = fakeState.spawns.length;
      fakeState.spawns.push({ command, args: [...args] });
      const mode = fakeState.modes[index] ?? fakeState.mode;
      const controller = makeFakeChild(opts.category, opts.label, mode);
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
  findCursorExecutableOnPath: () => fakeState.binaryPath,
  formatCursorBinaryMissingMessage: (input: unknown) => `Cursor runtime binary is missing: ${String(input)}`,
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
  /** Message ids settled per finish / retry, so per-delivery ownership is observable. */
  finishIds: string[][];
  retryIds: string[][];
  forwardedTexts: string[];
  /** When set, forwardResult rejects with this error (finding 3 failure path). */
  forwardError?: Error;
};

function idsOf(messages: SessionMessage | readonly SessionMessage[]): string[] {
  return (Array.isArray(messages) ? messages : [messages]).map((m: SessionMessage) => m.id);
}

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
    forwardResult: async (text: string) => {
      capture.forwardedTexts.push(text);
      if (capture.forwardError) throw capture.forwardError;
    },
    finishTurn: async (messages, outcome) => {
      capture.finishOutcomes.push(outcome);
      capture.finishIds.push(idsOf(messages));
    },
    retryTurn: (messages, reason) => {
      capture.retryReasons.push(reason);
      capture.retryIds.push(idsOf(messages));
    },
    replaceSessionId: () => {},
  };
}

function makeMessage(content: string, id = "msg-1"): SessionMessage {
  return { id, chatId: "chat-cursor", senderId: "sender-1", format: "text", content, metadata: {} };
}

function newCapture(): CtxCapture {
  return { events: [], finishOutcomes: [], retryReasons: [], finishIds: [], retryIds: [], forwardedTexts: [] };
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
  fakeState.spawns.length = 0;
  fakeState.modes.length = 0;
  fakeState.mode = "success";
  fakeState.binaryPath = "/fake/agent";
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("cursor handler — first-turn disposition (finding 2)", () => {
  it("a successful first turn returns the cursor-minted session id and forwards the result", async () => {
    fakeState.mode = "success";
    const capture = newCapture();
    const handler = createCursorHandler({ workspaceRoot, runtimeProvider: "cursor" });
    const result = await handler.start(makeMessage("hi"), makeContext(capture));
    const sessionId = typeof result === "string" ? result : result.sessionId;
    expect(sessionId).toBe("sess-real-abc");
    expect(capture.finishOutcomes.at(-1)?.status).toBe("success");
    // forwardResult (the turn-completion hook) is invoked with the result text (finding 3).
    expect(capture.forwardedTexts).toEqual(["done"]);
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

describe("cursor handler — forwardResult contract (finding 3)", () => {
  it("routes a forwardResult rejection into a consumed forward-failed settlement", async () => {
    fakeState.mode = "success";
    const capture = newCapture();
    capture.forwardError = new Error("trigger sink offline");
    const handler = createCursorHandler({ workspaceRoot, runtimeProvider: "cursor" });

    await handler.start(makeMessage("hi"), makeContext(capture));

    // The hook was still invoked, and its failure became a terminal consumed
    // error — not a silently-skipped hook nor a success ACK.
    expect(capture.forwardedTexts).toEqual(["done"]);
    expect(capture.retryReasons).toHaveLength(0);
    expect(capture.finishOutcomes).toHaveLength(1);
    expect(capture.finishOutcomes[0]).toMatchObject({
      status: "error",
      completion: "consumed",
      reason: "forward_failed",
    });
    const turnEnd = capture.events.find((e) => e.kind === "turn_end");
    expect(turnEnd?.kind === "turn_end" && turnEnd.payload.status).toBe("error");
    await handler.shutdown();
  });
});

describe("cursor handler — stderr-after-exit barrier (finding 4)", () => {
  it("gates finalize on `close` so a late auth stderr is classified terminal, not generic retry", async () => {
    fakeState.mode = "auth-late-stderr";
    const capture = newCapture();
    const handler = createCursorHandler({ workspaceRoot, runtimeProvider: "cursor" });

    await handler.start(makeMessage("hi"), makeContext(capture));

    // The auth tail arrived AFTER exit but before `close`; the barrier waited for
    // it, so the failure is terminal (credential) with a durable notice — not a
    // generic retry driven by an empty stderr tail.
    expect(capture.retryReasons).toHaveLength(0);
    expect(capture.finishOutcomes).toHaveLength(1);
    expect(capture.finishOutcomes[0]).toMatchObject({ terminal: true, completion: "consumed" });
    const terminal = structuredTerminalEvent(capture.events);
    expect(terminal?.event).toBe("provider_failure_terminal");
    expect(terminal?.category).toBe("credential");
    await handler.shutdown();
  });
});

describe("cursor handler — synthetic session id stays unconfirmed (finding 1)", () => {
  it("two consecutive pre-init failures never send a synthetic id through --resume", async () => {
    // Both the start turn and the injected drain turn fail before init.
    fakeState.mode = "auth";
    const capture = newCapture();
    const handler = createCursorHandler({ workspaceRoot, runtimeProvider: "cursor" });
    const ctx = makeContext(capture);

    const result = await handler.start(makeMessage("first", "m1"), ctx);
    const sessionId = typeof result === "string" ? result : result.sessionId;
    expect(sessionId.startsWith("cursor-pending-")).toBe(true);

    // Drain a second turn (also pre-init auth failure).
    handler.inject(makeMessage("second", "m2"));
    await waitFor(() => capture.finishOutcomes.length >= 2);

    expect(fakeState.spawns).toHaveLength(2);
    // Neither turn may replay the synthetic id — it was never observed on a stream.
    expect(fakeState.spawns[0]?.args).not.toContain("--resume");
    expect(fakeState.spawns[1]?.args).not.toContain("--resume");
    await handler.shutdown();
  });
});

describe("cursor handler — foreground provider-turn retry loop (finding 2)", () => {
  it("re-spawns generic no-result crashes across attempts, then settles on success", async () => {
    fakeState.modes = ["no-result", "no-result", "success"];
    const capture = newCapture();
    const handler = createCursorHandler({
      workspaceRoot,
      runtimeProvider: "cursor",
      cursorRetryDelayCapMs: 5, // keep the foreground backoff tiny
    });

    const result = await handler.start(makeMessage("hi"), makeContext(capture));
    const sessionId = typeof result === "string" ? result : result.sessionId;

    // Three in-handler spawns: two retried no-result crashes + one success.
    expect(fakeState.spawns).toHaveLength(3);
    expect(sessionId).toBe("sess-real-abc");
    // The loop handed the delivery back exactly once (settled complete), not per attempt.
    expect(capture.retryReasons).toHaveLength(0);
    expect(capture.finishOutcomes).toHaveLength(1);
    expect(capture.finishOutcomes[0]?.status).toBe("success");
    await handler.shutdown();
  });
});

describe("cursor handler — missing binary after bind (finding 3)", () => {
  it("settles a terminal capability failure with a durable notice, not a bare retry", async () => {
    fakeState.binaryPath = null;
    const capture = newCapture();
    const handler = createCursorHandler({ workspaceRoot, runtimeProvider: "cursor" });

    const result = await handler.start(makeMessage("hi"), makeContext(capture));
    const sessionId = typeof result === "string" ? result : result.sessionId;
    // No stream ever ran → synthetic unconfirmed id, no spawn.
    expect(sessionId.startsWith("cursor-pending-")).toBe(true);
    expect(fakeState.spawns).toHaveLength(0);

    expect(capture.retryReasons).toHaveLength(0);
    expect(capture.finishOutcomes).toHaveLength(1);
    expect(capture.finishOutcomes[0]).toMatchObject({ terminal: true, completion: "consumed" });
    const terminal = structuredTerminalEvent(capture.events);
    expect(terminal?.event).toBe("provider_failure_terminal");
    expect(terminal?.category).toBe("capability");
    await handler.shutdown();
  });
});

describe("cursor handler — empty successful result still forwards (finding 5)", () => {
  it("calls forwardResult for an empty (silent/tool-only) successful result", async () => {
    fakeState.mode = "success-empty";
    const capture = newCapture();
    const handler = createCursorHandler({ workspaceRoot, runtimeProvider: "cursor" });

    await handler.start(makeMessage("hi"), makeContext(capture));

    // The completion hook fires even though the result text is empty.
    expect(capture.forwardedTexts).toEqual([""]);
    expect(capture.finishOutcomes).toHaveLength(1);
    expect(capture.finishOutcomes[0]?.status).toBe("success");
    await handler.shutdown();
  });
});

describe("cursor handler — per-turn ownership fence (finding 4)", () => {
  it("an abandoned continuation neither settles the new turn nor clears its live slots", async () => {
    // Turn A's child ignores every signal, so teardown ABANDONS it (bounded wait
    // times out) while it is still pending. Turn B is long-running so it is STILL
    // LIVE when A's stale continuation finally resumes.
    fakeState.modes = ["unkillable", "ignore-term"];
    const capture = newCapture();
    const handler = createCursorHandler({
      workspaceRoot,
      runtimeProvider: "cursor",
      cursorKillTerminateGraceMs: 20,
      cursorKillFinalWaitMs: 20,
    });
    const ctx = makeContext(capture);

    // Fire Turn A (msg mA) — start() stays pending on the unkillable child.
    const startA = handler.start(makeMessage("a", "mA"), ctx);
    await waitFor(() => fakeState.spawns.length >= 1);

    // Suspend abandons Turn A (SIGTERM+SIGKILL recorded but ignored; wait times out).
    await handler.suspend();
    const childA = fakeState.children[0] as FakeChildController;
    expect(childA.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(childA.isAlive).toBe(true); // still pending — outlived teardown

    // Fire Turn B (msg mB) via resume while Turn A is still abandoned/pending. B
    // is long-running, so it stays the CURRENT owner of the live slots.
    const resumeB = handler.resume(makeMessage("b", "mB"), "sess-real-abc", ctx);
    await waitFor(() => fakeState.spawns.length >= 2);
    const childB = fakeState.children[1] as FakeChildController;

    // Now let the abandoned Turn A finally close and its continuation resume —
    // while Turn B is still live.
    childA.forceClose();
    await startA;

    // The stale continuation only retried its OWN delivery (mA) — it did NOT
    // settle Turn B's delivery (mB), and settled nothing for B.
    expect(capture.retryIds).toEqual([["mA"]]);
    expect(capture.retryReasons).toEqual(["cursor_turn_aborted"]);
    expect(capture.finishIds).toEqual([]);

    // And it did NOT clear Turn B's live child slot: a shutdown still targets
    // childB (finding 4(b)). If A had cleared the slot, shutdown would kill nothing.
    await handler.shutdown();
    expect(childB.signals).toContain("SIGTERM");
    await resumeB;
    // Turn B's own delivery is recovered on its (later) abort — never by A.
    expect(capture.retryIds).toContainEqual(["mB"]);
  });
});
