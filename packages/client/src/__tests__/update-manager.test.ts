import { EventEmitter } from "node:events";
import type { ClientConfig } from "@first-tree/shared/config";
import { describe, expect, it, vi } from "vitest";
import type { ServerWelcome } from "../client-connection.js";
import { UpdateManager } from "../runtime/update-manager.js";

/**
 * Minimal stand-in for ClientConnection. UpdateManager only touches
 * `.on("server:welcome")` and `.off(...)`, so a plain EventEmitter keeps the
 * test harness free of sockets.
 */
type FakeConnection = EventEmitter & {
  emitWelcome(frame: ServerWelcome): void;
};

function makeFakeConnection(): FakeConnection {
  const emitter = new EventEmitter() as FakeConnection;
  emitter.emitWelcome = (welcome) => {
    emitter.emit("server:welcome", welcome);
  };
  return emitter;
}

function makeUpdateConfig(overrides: Partial<ClientConfig["update"]> = {}): ClientConfig["update"] {
  return {
    policy: "auto",
    restart_quiet_seconds: 30,
    restart_check_interval_seconds: 10,
    prompt_timeout_seconds: 60,
    ...overrides,
  };
}

function makeWelcome(serverCommandVersion: string, isReconnect = false): ServerWelcome {
  return {
    frame: {
      type: "server:welcome",
      serverCommandVersion,
      serverTimeMs: 1_700_000_000_000,
    },
    isReconnect,
  };
}

async function waitForMicrotasks(): Promise<void> {
  // UpdateManager's welcome handler is async; allow one macro-tick so
  // `executeUpdate` resolves and test assertions see the final state.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("UpdateManager decision flow", () => {
  it("does nothing when server version matches", async () => {
    const conn = makeFakeConnection();
    const executeUpdate = vi.fn(async () => ({ installed: false }));
    const prompt = vi.fn(async () => true);
    UpdateManager.attach(conn, {
      currentVersion: "0.9.2",
      updateConfig: makeUpdateConfig({ policy: "auto" }),
      isTTY: false,
      log: () => {},
      getQuietGateSnapshot: () => ({ activeCount: 0, lastActivityMs: 0 }),
      prompt,
      executeUpdate,
    });

    conn.emitWelcome(makeWelcome("0.9.2"));
    await waitForMicrotasks();

    expect(executeUpdate).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("does nothing when client is ahead of server (lt)", async () => {
    const conn = makeFakeConnection();
    const executeUpdate = vi.fn(async () => ({ installed: false }));
    UpdateManager.attach(conn, {
      currentVersion: "0.9.3",
      updateConfig: makeUpdateConfig({ policy: "auto" }),
      isTTY: false,
      log: () => {},
      getQuietGateSnapshot: () => ({ activeCount: 0, lastActivityMs: 0 }),
      prompt: async () => true,
      executeUpdate,
    });

    conn.emitWelcome(makeWelcome("0.9.2"));
    await waitForMicrotasks();

    expect(executeUpdate).not.toHaveBeenCalled();
  });

  it("does nothing when policy=off even on drift", async () => {
    const conn = makeFakeConnection();
    const executeUpdate = vi.fn(async () => ({ installed: false }));
    UpdateManager.attach(conn, {
      currentVersion: "0.8.4",
      updateConfig: makeUpdateConfig({ policy: "off" }),
      isTTY: true,
      log: () => {},
      getQuietGateSnapshot: () => ({ activeCount: 0, lastActivityMs: 0 }),
      prompt: async () => true,
      executeUpdate,
    });

    conn.emitWelcome(makeWelcome("0.9.2"));
    await waitForMicrotasks();

    expect(executeUpdate).not.toHaveBeenCalled();
  });

  it("logs and skips invalid advertised or current versions", async () => {
    const firstConn = makeFakeConnection();
    const firstLogs: string[] = [];
    const firstExecuteUpdate = vi.fn(async () => ({ installed: false }));
    UpdateManager.attach(firstConn, {
      currentVersion: "0.9.2",
      updateConfig: makeUpdateConfig({ policy: "auto" }),
      isTTY: false,
      log: (_level, msg) => firstLogs.push(msg),
      getQuietGateSnapshot: () => ({ activeCount: 0, lastActivityMs: 0 }),
      prompt: async () => true,
      executeUpdate: firstExecuteUpdate,
    });

    firstConn.emitWelcome(makeWelcome("not-semver"));
    await waitForMicrotasks();

    expect(firstExecuteUpdate).not.toHaveBeenCalled();
    expect(firstLogs).toContain('Server advertised invalid version "not-semver"; skipping drift check');

    const secondConn = makeFakeConnection();
    const secondLogs: string[] = [];
    const secondExecuteUpdate = vi.fn(async () => ({ installed: false }));
    UpdateManager.attach(secondConn, {
      currentVersion: "dev-local",
      updateConfig: makeUpdateConfig({ policy: "auto" }),
      isTTY: false,
      log: (_level, msg) => secondLogs.push(msg),
      getQuietGateSnapshot: () => ({ activeCount: 0, lastActivityMs: 0 }),
      prompt: async () => true,
      executeUpdate: secondExecuteUpdate,
    });

    secondConn.emitWelcome(makeWelcome("0.9.2"));
    await waitForMicrotasks();

    expect(secondExecuteUpdate).not.toHaveBeenCalled();
    expect(secondLogs).toContain('Own version "dev-local" is not valid SemVer; skipping drift check');
  });

  it("policy=prompt, daemon (no TTY) → log only, no prompt or update", async () => {
    const conn = makeFakeConnection();
    const prompt = vi.fn(async () => true);
    const executeUpdate = vi.fn(async () => ({ installed: false }));
    UpdateManager.attach(conn, {
      currentVersion: "0.8.4",
      updateConfig: makeUpdateConfig({ policy: "prompt" }),
      isTTY: false,
      log: () => {},
      getQuietGateSnapshot: () => ({ activeCount: 0, lastActivityMs: 0 }),
      prompt,
      executeUpdate,
    });

    conn.emitWelcome(makeWelcome("0.9.2"));
    await waitForMicrotasks();

    expect(prompt).not.toHaveBeenCalled();
    expect(executeUpdate).not.toHaveBeenCalled();
  });

  it("policy=prompt, TTY, user says Y → executeUpdate, no quiet-gate wait", async () => {
    const conn = makeFakeConnection();
    const prompt = vi.fn(async () => true);
    const executeUpdate = vi.fn(async () => ({ installed: false }));
    const getQuietGateSnapshot = vi.fn(() => ({
      activeCount: 5,
      lastActivityMs: Date.now(), // busy now — would block quiet gate
    }));

    UpdateManager.attach(conn, {
      currentVersion: "0.8.4",
      updateConfig: makeUpdateConfig({ policy: "prompt" }),
      isTTY: true,
      log: () => {},
      getQuietGateSnapshot,
      prompt,
      executeUpdate,
    });

    // Reconnect welcome — quiet gate would normally apply, but explicit Y waives it.
    conn.emitWelcome(makeWelcome("0.9.2", true));
    await waitForMicrotasks();

    expect(prompt).toHaveBeenCalledOnce();
    expect(executeUpdate).toHaveBeenCalledOnce();
    expect(getQuietGateSnapshot).not.toHaveBeenCalled();
  });

  it("policy=prompt, TTY, user declines → no update", async () => {
    const conn = makeFakeConnection();
    const prompt = vi.fn(async () => false);
    const executeUpdate = vi.fn(async () => ({ installed: false }));
    UpdateManager.attach(conn, {
      currentVersion: "0.8.4",
      updateConfig: makeUpdateConfig({ policy: "prompt" }),
      isTTY: true,
      log: () => {},
      getQuietGateSnapshot: () => ({ activeCount: 0, lastActivityMs: 0 }),
      prompt,
      executeUpdate,
    });

    conn.emitWelcome(makeWelcome("0.9.2"));
    await waitForMicrotasks();

    expect(prompt).toHaveBeenCalledOnce();
    expect(executeUpdate).not.toHaveBeenCalled();
  });

  it("logs update decision failures from the async welcome listener", async () => {
    const conn = makeFakeConnection();
    const logs: string[] = [];
    UpdateManager.attach(conn, {
      currentVersion: "0.8.4",
      updateConfig: makeUpdateConfig({ policy: "prompt" }),
      isTTY: true,
      log: (_level, msg) => logs.push(msg),
      getQuietGateSnapshot: () => ({ activeCount: 0, lastActivityMs: 0 }),
      prompt: async () => {
        throw new Error("prompt failed");
      },
      executeUpdate: async () => ({ installed: false }),
    });

    conn.emitWelcome(makeWelcome("0.9.2"));
    await waitForMicrotasks();

    expect(logs).toContain("update decision failed: prompt failed");

    const stringConn = makeFakeConnection();
    UpdateManager.attach(stringConn, {
      currentVersion: "0.8.4",
      updateConfig: makeUpdateConfig({ policy: "prompt" }),
      isTTY: true,
      log: (_level, msg) => logs.push(msg),
      getQuietGateSnapshot: () => ({ activeCount: 0, lastActivityMs: 0 }),
      prompt: async () => {
        throw "prompt string failed";
      },
      executeUpdate: async () => ({ installed: false }),
    });

    stringConn.emitWelcome(makeWelcome("0.9.2"));
    await waitForMicrotasks();

    expect(logs).toContain("update decision failed: prompt string failed");
  });

  it("policy=auto, daemon, first welcome → update immediately (no quiet gate)", async () => {
    const conn = makeFakeConnection();
    const executeUpdate = vi.fn(async () => ({ installed: false }));
    const getQuietGateSnapshot = vi.fn(() => ({
      activeCount: 3,
      lastActivityMs: Date.now(),
    }));

    UpdateManager.attach(conn, {
      currentVersion: "0.8.4",
      updateConfig: makeUpdateConfig({ policy: "auto" }),
      isTTY: false,
      log: () => {},
      getQuietGateSnapshot,
      prompt: async () => false,
      executeUpdate,
    });

    conn.emitWelcome(makeWelcome("0.9.2", false));
    await waitForMicrotasks();

    expect(executeUpdate).toHaveBeenCalledOnce();
    expect(getQuietGateSnapshot).not.toHaveBeenCalled();
  });

  it("policy=auto, TTY waits briefly and stops if disposed during the notice delay", async () => {
    vi.useFakeTimers();
    try {
      const conn = makeFakeConnection();
      const logs: string[] = [];
      const executeUpdate = vi.fn(async () => ({ installed: false }));
      const mgr = UpdateManager.attach(conn, {
        currentVersion: "0.8.4",
        updateConfig: makeUpdateConfig({ policy: "auto" }),
        isTTY: true,
        log: (_level, msg) => logs.push(msg),
        getQuietGateSnapshot: () => ({ activeCount: 0, lastActivityMs: 0 }),
        prompt: async () => false,
        executeUpdate,
      });

      conn.emitWelcome(makeWelcome("0.9.2", false));
      await vi.advanceTimersByTimeAsync(1);
      expect(logs).toContain("Auto-update starting in 5s");

      mgr.dispose();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(executeUpdate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("policy=auto, daemon, reconnect welcome → waits on quiet gate until idle", async () => {
    vi.useFakeTimers();
    try {
      const conn = makeFakeConnection();
      const executeUpdate = vi.fn(async () => ({ installed: false }));
      // First call returns busy, second call returns idle.
      const snapshots = [
        { activeCount: 1, lastActivityMs: Date.now() },
        { activeCount: 0, lastActivityMs: 0 },
      ];
      const getQuietGateSnapshot = vi.fn(() => snapshots.shift() ?? { activeCount: 0, lastActivityMs: 0 });

      UpdateManager.attach(conn, {
        currentVersion: "0.8.4",
        updateConfig: makeUpdateConfig({
          policy: "auto",
          restart_quiet_seconds: 30,
          restart_check_interval_seconds: 10,
        }),
        isTTY: false,
        log: () => {},
        getQuietGateSnapshot,
        prompt: async () => false,
        executeUpdate,
      });

      conn.emitWelcome(makeWelcome("0.9.2", true));
      // Allow the async handler to run up to the first quiet-gate check
      await vi.advanceTimersByTimeAsync(1);
      expect(getQuietGateSnapshot).toHaveBeenCalledTimes(1);
      expect(executeUpdate).not.toHaveBeenCalled();

      // Advance past one re-check interval (10s) — second snapshot is idle, update fires.
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(getQuietGateSnapshot).toHaveBeenCalledTimes(2);
      expect(executeUpdate).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispose() is idempotent and clears a pending quiet-gate timer", async () => {
    vi.useFakeTimers();
    try {
      const conn = makeFakeConnection();
      const executeUpdate = vi.fn(async () => ({ installed: false }));
      const mgr = UpdateManager.attach(conn, {
        currentVersion: "0.8.4",
        updateConfig: makeUpdateConfig({
          policy: "auto",
          restart_quiet_seconds: 30,
          restart_check_interval_seconds: 10,
        }),
        isTTY: false,
        log: () => {},
        getQuietGateSnapshot: () => ({ activeCount: 1, lastActivityMs: Date.now() }),
        prompt: async () => false,
        executeUpdate,
      });

      conn.emitWelcome(makeWelcome("0.9.2", true));
      await vi.advanceTimersByTimeAsync(1);
      mgr.dispose();
      mgr.dispose();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(executeUpdate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the update when disposed while the reconnect quiet gate is checking", async () => {
    const conn = makeFakeConnection();
    const executeUpdate = vi.fn(async () => ({ installed: false }));
    let mgr: UpdateManager;
    mgr = UpdateManager.attach(conn, {
      currentVersion: "0.8.4",
      updateConfig: makeUpdateConfig({ policy: "auto" }),
      isTTY: false,
      log: () => {},
      getQuietGateSnapshot: () => {
        mgr.dispose();
        return { activeCount: 0, lastActivityMs: 0 };
      },
      prompt: async () => false,
      executeUpdate,
    });

    conn.emitWelcome(makeWelcome("0.9.2", true));
    await waitForMicrotasks();

    expect(executeUpdate).not.toHaveBeenCalled();
  });

  it("dispose() stops listening — later welcome frames are ignored", async () => {
    const conn = makeFakeConnection();
    const executeUpdate = vi.fn(async () => ({ installed: false }));
    const mgr = UpdateManager.attach(conn, {
      currentVersion: "0.8.4",
      updateConfig: makeUpdateConfig({ policy: "auto" }),
      isTTY: false,
      log: () => {},
      getQuietGateSnapshot: () => ({ activeCount: 0, lastActivityMs: 0 }),
      prompt: async () => false,
      executeUpdate,
    });

    mgr.dispose();
    conn.emitWelcome(makeWelcome("0.9.2"));
    await waitForMicrotasks();

    expect(executeUpdate).not.toHaveBeenCalled();
  });

  it("standalone install (installed=true) stops further retry attempts", async () => {
    const conn = makeFakeConnection();
    // Standalone mode: executeUpdate installs npm bits but stays alive.
    // Later welcome frames must not re-fire npm — only a process restart
    // can pick up the new version.
    const executeUpdate = vi.fn(async () => ({ installed: true }));
    UpdateManager.attach(conn, {
      currentVersion: "0.8.4",
      updateConfig: makeUpdateConfig({ policy: "auto" }),
      isTTY: false,
      log: () => {},
      getQuietGateSnapshot: () => ({ activeCount: 0, lastActivityMs: 0 }),
      prompt: async () => false,
      executeUpdate,
    });

    conn.emitWelcome(makeWelcome("0.9.2", false));
    await waitForMicrotasks();
    expect(executeUpdate).toHaveBeenCalledOnce();

    conn.emitWelcome(makeWelcome("0.9.2", true));
    await waitForMicrotasks();
    expect(executeUpdate).toHaveBeenCalledOnce();
  });

  it("logs executeUpdate failures and retries later", async () => {
    const conn = makeFakeConnection();
    const logs: string[] = [];
    const executeUpdate = vi.fn().mockRejectedValueOnce("install exploded").mockResolvedValueOnce({ installed: false });
    UpdateManager.attach(conn, {
      currentVersion: "0.8.4",
      updateConfig: makeUpdateConfig({ policy: "auto" }),
      isTTY: false,
      log: (_level, msg) => logs.push(msg),
      getQuietGateSnapshot: () => ({ activeCount: 0, lastActivityMs: 0 }),
      prompt: async () => false,
      executeUpdate,
    });

    conn.emitWelcome(makeWelcome("0.9.2", false));
    await waitForMicrotasks();
    conn.emitWelcome(makeWelcome("0.9.2", false));
    await waitForMicrotasks();

    expect(logs).toContain("Self-update threw: install exploded");
    expect(executeUpdate).toHaveBeenCalledTimes(2);

    const errorConn = makeFakeConnection();
    const errorExecuteUpdate = vi.fn().mockRejectedValue(new Error("install error"));
    UpdateManager.attach(errorConn, {
      currentVersion: "0.8.4",
      updateConfig: makeUpdateConfig({ policy: "auto" }),
      isTTY: false,
      log: (_level, msg) => logs.push(msg),
      getQuietGateSnapshot: () => ({ activeCount: 0, lastActivityMs: 0 }),
      prompt: async () => false,
      executeUpdate: errorExecuteUpdate,
    });

    errorConn.emitWelcome(makeWelcome("0.9.2", false));
    await waitForMicrotasks();

    expect(logs).toContain("Self-update threw: install error");
  });
});
