import { EventEmitter } from "node:events";
import type { ClientConfig } from "@first-tree/shared/config";
import { describe, expect, it, vi } from "vitest";
import type { ServerWelcome } from "../client-connection.js";
import {
  type RefreshUpdateTargetResult,
  UpdateManager,
  type UpdateManagerConnection,
} from "../runtime/update-manager.js";

class FakeConnection extends EventEmitter implements UpdateManagerConnection {
  emitWelcome(welcome: ServerWelcome): void {
    this.emit("server:welcome", welcome);
  }

  on(event: "server:welcome", listener: (welcome: ServerWelcome) => void): this {
    return super.on(event, listener);
  }

  off(event: "server:welcome", listener: (welcome: ServerWelcome) => void): this {
    return super.off(event, listener);
  }
}

type RefreshScenario = {
  readonly currentVersion: string;
  readonly advertisedVersion: string;
  readonly refresh: () => Promise<RefreshUpdateTargetResult>;
};

function makeUpdateConfig(): ClientConfig["update"] {
  return {
    policy: "auto",
    restart_quiet_seconds: 30,
    restart_check_interval_seconds: 10,
    prompt_timeout_seconds: 60,
  };
}

function makeWelcome(serverCommandVersion: string): ServerWelcome {
  return {
    frame: {
      type: "server:welcome",
      serverCommandVersion,
      serverTimeMs: 1_700_000_000_000,
    },
    isReconnect: false,
  };
}

async function waitForUpdateDecision(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function runAutoRefreshScenario(input: RefreshScenario): Promise<{
  readonly executeUpdate: ReturnType<typeof vi.fn>;
  readonly logs: readonly string[];
}> {
  const conn = new FakeConnection();
  const logs: string[] = [];
  const executeUpdate = vi.fn(async () => ({ installed: false }));
  const refreshServerTarget = vi.fn(input.refresh);

  UpdateManager.attach(conn, {
    currentVersion: input.currentVersion,
    updateConfig: makeUpdateConfig(),
    isTTY: false,
    log: (_level, msg) => logs.push(msg),
    getQuietGateSnapshot: () => ({ activeCount: 0, lastActivityMs: 0 }),
    prompt: async () => false,
    executeUpdate,
    refreshServerTarget,
  });

  conn.emitWelcome(makeWelcome(input.advertisedVersion));
  await waitForUpdateDecision();

  return { executeUpdate, logs };
}

describe("UpdateManager auto refresh fallback decisions", () => {
  it("continues with the advertised target when refresh reports a recoverable failure", async () => {
    const { executeUpdate, logs } = await runAutoRefreshScenario({
      currentVersion: "0.8.4",
      advertisedVersion: "1.0.0",
      refresh: async () => ({ ok: false, reason: "offline" }),
    });

    expect(logs).toContain("Could not refresh server update target (offline); continuing with 1.0.0");
    expect(executeUpdate).toHaveBeenCalledWith({ currentVersion: "0.8.4", targetVersion: "1.0.0" });
  });

  it("continues with the advertised target when refresh returns an invalid version", async () => {
    const { executeUpdate, logs } = await runAutoRefreshScenario({
      currentVersion: "0.8.4",
      advertisedVersion: "1.0.0",
      refresh: async () => ({ ok: true, targetVersion: "not-semver" }),
    });

    expect(logs).toContain('Server target refresh returned invalid version "not-semver"; continuing with 1.0.0');
    expect(executeUpdate).toHaveBeenCalledWith({ currentVersion: "0.8.4", targetVersion: "1.0.0" });
  });

  it("continues with the advertised target when refresh throws", async () => {
    const { executeUpdate, logs } = await runAutoRefreshScenario({
      currentVersion: "0.8.4",
      advertisedVersion: "1.0.0",
      refresh: async () => {
        throw new Error("refresh down");
      },
    });

    expect(logs).toContain("Server target refresh threw: refresh down; continuing with 1.0.0");
    expect(executeUpdate).toHaveBeenCalledWith({ currentVersion: "0.8.4", targetVersion: "1.0.0" });
  });

  it("skips self-update when refresh says the target now matches the running version", async () => {
    const { executeUpdate, logs } = await runAutoRefreshScenario({
      currentVersion: "0.9.2",
      advertisedVersion: "1.0.0",
      refresh: async () => ({ ok: true, targetVersion: "0.9.2" }),
    });

    expect(logs).toContain("Server update target refreshed: 1.0.0 -> 0.9.2");
    expect(logs).toContain("Server update target 0.9.2 now matches running version; skipping self-update");
    expect(executeUpdate).not.toHaveBeenCalled();
  });

  it("skips self-update when refresh rolls back below the running version", async () => {
    const { executeUpdate, logs } = await runAutoRefreshScenario({
      currentVersion: "0.9.3",
      advertisedVersion: "1.0.0",
      refresh: async () => ({ ok: true, targetVersion: "0.9.2" }),
    });

    expect(logs).toContain("Server update target refreshed: 1.0.0 -> 0.9.2");
    expect(logs).toContain("Server update target 0.9.2 is older than running 0.9.3; skipping self-update");
    expect(executeUpdate).not.toHaveBeenCalled();
  });
});
