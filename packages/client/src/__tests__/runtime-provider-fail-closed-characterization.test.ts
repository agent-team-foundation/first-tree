/**
 * Characterization for SessionManager.runtimeProvider resolution and the
 * provider-boundary guard's coverage of session-manager.ts.
 *
 * Detects live implementation via `detectFailClosed()` so the same file:
 * - PASSes on PR base (documents silent Claude-era fallback + guard gap)
 * - PASSes on this branch after fail-closed + guard inclusion land
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeProvider } from "@first-tree/shared";
import { describe, expect, it, vi } from "vitest";
import type { AgentHandler } from "../runtime/handler.js";
import { SessionManager } from "../runtime/session-manager.js";
import type { FirstTreeHubSDK } from "../sdk.js";
import { silentLogger } from "./_logger-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const sessionManagerSourcePath = join(here, "..", "runtime", "session-manager.ts");
const guardSourcePath = join(here, "provider-boundary-guard.test.ts");

type SessionManagerInternals = {
  runtimeProvider(): RuntimeProvider;
};

function internals(sm: SessionManager): SessionManagerInternals {
  return sm as unknown as SessionManagerInternals;
}

function handler(): AgentHandler {
  return {
    start: async () => ({ sessionId: "sess", route: { kind: "owned" as const, mode: "queued" as const } }),
    resume: async () => ({ sessionId: "sess", route: { kind: "owned" as const, mode: "queued" as const } }),
    inject: () => ({ kind: "owned", mode: "queued" }),
    suspend: async () => undefined,
    shutdown: async () => undefined,
  };
}

function mockSdk(): FirstTreeHubSDK {
  return {
    serverUrl: "https://first-tree.example.test",
    register: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue({ id: "m" }),
    sendToAgent: vi.fn().mockResolvedValue({ id: "m" }),
    listChatParticipants: vi.fn().mockResolvedValue([]),
  } as unknown as FirstTreeHubSDK;
}

function makeManager(opts: { runtimeProvider?: unknown } = {}): SessionManager {
  const handlerConfig: Record<string, unknown> = {
    workspaceRoot: "/tmp/runtime-provider-char",
  };
  if ("runtimeProvider" in opts) {
    handlerConfig.runtimeProvider = opts.runtimeProvider;
  }
  return new SessionManager({
    session: {
      idle_timeout: 300,
      max_sessions: 10,
      working_grace_seconds: 3600,
      reconcile_interval_seconds: 300,
    },
    concurrency: 5,
    handlerFactory: () => handler(),
    handlerConfig: handlerConfig as ConstructorParameters<typeof SessionManager>[0]["handlerConfig"],
    agentIdentity: {
      agentId: "agent-1",
      inboxId: "inbox-1",
      displayName: "Agent",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: mockSdk(),
    log: silentLogger(),
    ackEntry: async () => undefined,
  });
}

/** True once SessionManager no longer silently defaults a missing provider. */
function detectFailClosed(): boolean {
  const source = readFileSync(sessionManagerSourcePath, "utf8");
  return !source.includes('return parsed.success ? parsed.data : "claude-code"');
}

describe("characterization — SessionManager.runtimeProvider", () => {
  it("returns the configured provider when it is a valid RuntimeProvider", async () => {
    const sm = makeManager({ runtimeProvider: "codex" });
    expect(internals(sm).runtimeProvider()).toBe("codex");
    await sm.shutdown();
  });

  it("handles missing runtimeProvider according to the fail-closed contract", async () => {
    const sm = makeManager({});
    const failClosed = detectFailClosed();
    if (failClosed) {
      expect(() => internals(sm).runtimeProvider()).toThrow(/runtimeProvider/i);
    } else {
      // PRE-REFACTOR: silent Claude-era fallback (the debt this slice removes).
      expect(internals(sm).runtimeProvider()).toBe("claude-code");
    }
    await sm.shutdown();
  });

  it("handles invalid runtimeProvider according to the fail-closed contract", async () => {
    const sm = makeManager({ runtimeProvider: "not-a-provider" });
    const failClosed = detectFailClosed();
    if (failClosed) {
      expect(() => internals(sm).runtimeProvider()).toThrow(/runtimeProvider/i);
    } else {
      expect(internals(sm).runtimeProvider()).toBe("claude-code");
    }
    await sm.shutdown();
  });
});

describe("characterization — provider-boundary guard covers SessionManager", () => {
  it("lists runtime/session-manager.ts among guarded client files once fail-closed lands", () => {
    const guardSource = readFileSync(guardSourcePath, "utf8");
    const failClosed = detectFailClosed();
    if (failClosed) {
      expect(guardSource).toContain('"runtime/session-manager.ts"');
    } else {
      // PRE-REFACTOR: SessionManager is still outside the guard (known gap).
      expect(guardSource).not.toContain('"runtime/session-manager.ts"');
    }
  });

  it("after fail-closed, session-manager.ts has no concrete provider string literals", () => {
    const failClosed = detectFailClosed();
    if (!failClosed) return;
    const source = readFileSync(sessionManagerSourcePath, "utf8");
    for (const id of ["claude-code", "claude-code-tui", "codex", "cursor", "grok", "kimi-code", "opencode", "pi"]) {
      expect(source.includes(`"${id}"`) || source.includes(`'${id}'`), `literal ${id}`).toBe(false);
    }
  });
});
