import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cliFetchMock = vi.hoisted(() => vi.fn());
const serviceStatusMock = vi.hoisted(() => vi.fn());
const stderrMock = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

vi.mock("../core/cli-fetch.js", () => ({
  cliFetch: cliFetchMock,
}));

vi.mock("../core/service-install.js", () => ({
  getClientServiceStatus: serviceStatusMock,
}));

const originalFirstTreeHome = process.env.FIRST_TREE_HOME;
const originalServerUrl = process.env.FIRST_TREE_SERVER_URL;
const originalNodeVersion = process.versions.node;

let home: string;

function writeAgent(name: string, body: string): void {
  const dir = join(home, "config", "agents", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.yaml"), body);
}

beforeEach(() => {
  home = join(tmpdir(), `ft-doctor-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(home, "config"), { recursive: true });
  process.env.FIRST_TREE_HOME = home;
  delete process.env.FIRST_TREE_SERVER_URL;
  cliFetchMock.mockReset();
  serviceStatusMock.mockReset();
  stderrMock.mockClear();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (originalFirstTreeHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalFirstTreeHome;
  if (originalServerUrl === undefined) delete process.env.FIRST_TREE_SERVER_URL;
  else process.env.FIRST_TREE_SERVER_URL = originalServerUrl;
  Object.defineProperty(process.versions, "node", { configurable: true, value: originalNodeVersion });
});

describe("doctor core checks", () => {
  it("checks config, server reachability, websocket reachability, and local agents", async () => {
    const {
      checkAgentConfigs,
      checkClientConfig,
      checkNodeVersion,
      checkServerReachable,
      checkWebSocket,
      reconcileAgentConfigs,
    } = await import("../core/doctor.js");

    expect(checkNodeVersion()).toMatchObject({
      label: "Node.js",
      ok: true,
    });
    Object.defineProperty(process.versions, "node", { configurable: true, value: "22.12.0" });
    expect(checkNodeVersion()).toEqual({
      label: "Node.js",
      ok: false,
      detail: "v22.12.0 (requires >= 22.13)",
    });
    Object.defineProperty(process.versions, "node", { configurable: true, value: "22.13.0" });
    expect(checkNodeVersion()).toEqual({
      label: "Node.js",
      ok: true,
      detail: "v22.13.0",
    });
    Object.defineProperty(process.versions, "node", { configurable: true, value: originalNodeVersion });

    expect(checkClientConfig()).toEqual({
      label: "Config",
      ok: false,
      detail: "no config file or env vars found",
    });

    process.env.FIRST_TREE_SERVER_URL = "http://env.test";
    expect(checkClientConfig()).toEqual({ label: "Config", ok: true, detail: "via environment variables" });

    writeFileSync(
      join(home, "config", "client.yaml"),
      "server:\n  url: http://first-tree.test\nclient:\n  id: client_1234abcd\n",
    );
    process.env.FIRST_TREE_SERVER_URL = "http://env.test";
    expect(checkClientConfig()).toEqual({ label: "Config", ok: true, detail: "config file + env vars" });
    delete process.env.FIRST_TREE_SERVER_URL;
    expect(checkClientConfig().detail).toContain("client.yaml");

    cliFetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    await expect(checkServerReachable()).resolves.toEqual({
      label: "Server URL",
      ok: true,
      detail: "http://first-tree.test",
    });

    cliFetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    await expect(checkServerReachable()).resolves.toEqual({
      label: "Server URL",
      ok: false,
      detail: "unhealthy (HTTP 503) at http://first-tree.test",
    });

    cliFetchMock.mockRejectedValueOnce(new Error("network"));
    await expect(checkServerReachable()).resolves.toEqual({
      label: "Server URL",
      ok: false,
      detail: "unreachable at http://first-tree.test",
    });

    cliFetchMock.mockRejectedValueOnce(new Error("network"));
    await expect(checkWebSocket()).resolves.toEqual({
      label: "WebSocket",
      ok: false,
      detail: "server unreachable at http://first-tree.test",
    });

    cliFetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    await expect(checkWebSocket()).resolves.toEqual({
      label: "WebSocket",
      ok: true,
      detail: "ws://first-tree.test (server reachable)",
    });

    cliFetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    await expect(checkWebSocket()).resolves.toEqual({
      label: "WebSocket",
      ok: false,
      detail: "server not healthy",
    });

    expect(checkAgentConfigs()).toEqual({ label: "Agents", ok: false, detail: "no agents configured" });
    mkdirSync(join(home, "config", "agents"), { recursive: true });
    expect(checkAgentConfigs()).toEqual({ label: "Agents", ok: false, detail: "no agents configured" });
    writeAgent("broken", "agentId: [not-valid\n");
    expect(checkAgentConfigs()).toEqual({ label: "Agents", ok: false, detail: "error reading agent configs" });
    rmSync(join(home, "config", "agents", "broken"), { recursive: true, force: true });
    writeAgent("nova", "agentId: agent-1\nruntime: claude-code\n");
    expect(checkAgentConfigs()).toEqual({ label: "Agents", ok: true, detail: "1 configured (nova)" });

    await expect(
      reconcileAgentConfigs({
        clientId: "client-1",
        listPinnedAgents: async () => [{ agentId: "agent-1", clientId: "client-1" }],
      }),
    ).resolves.toEqual({ label: "Agents", ok: true, detail: "1 configured, all pinned to this client" });

    await expect(
      reconcileAgentConfigs({
        clientId: "client-1",
        listPinnedAgents: async () => [{ agentId: "agent-1", clientId: "client-1", status: "suspended" }],
      }),
    ).resolves.toEqual({
      label: "Agents",
      ok: true,
      detail: "1 configured, 0 active and 1 suspended/disabled on this client",
    });

    writeAgent("moved", "agentId: agent-2\nruntime: claude-code\n");
    writeAgent("suspended", "agentId: agent-3\nruntime: claude-code\n");
    const stale = await reconcileAgentConfigs({
      clientId: "client-1",
      listPinnedAgents: async () => [
        { agentId: "agent-2", clientId: "client-2" },
        { agentId: "agent-3", clientId: "client-1", status: "suspended" },
      ],
    });
    expect(stale.ok).toBe(false);
    expect(stale.detail).toContain("moved [pinned to another client: client-2]");
    expect(stale.detail).toContain("1 suspended/disabled");
    expect(stale.detail).toContain("run `first-tree-dev agent prune`");

    for (let index = 4; index <= 10; index++) {
      writeAgent(`stale-${index}`, `agentId: agent-${index}\nruntime: claude-code\n`);
    }
    const truncated = await reconcileAgentConfigs({
      clientId: "client-1",
      listPinnedAgents: async () => [],
    });
    expect(truncated.ok).toBe(false);
    expect(truncated.detail).toContain("...+");
  });

  it("handles reconciliation failures and background-service states", async () => {
    const { checkBackgroundService, printResults, reconcileAgentConfigs } = await import("../core/doctor.js");
    const { checkServerReachable, checkWebSocket } = await import("../core/doctor.js");

    await expect(checkServerReachable()).resolves.toEqual({
      label: "Server URL",
      ok: false,
      detail: "not configured (FIRST_TREE_SERVER_URL or config file)",
    });
    await expect(checkWebSocket()).resolves.toEqual({
      label: "WebSocket",
      ok: false,
      detail: "cannot check (no server URL)",
    });

    await expect(
      reconcileAgentConfigs({
        clientId: "client-1",
        agentsDir: join(home, "missing-agents"),
        listPinnedAgents: async () => [],
      }),
    ).resolves.toEqual({ label: "Agents", ok: false, detail: "no agents configured" });

    writeAgent("nova", "agentId: agent-1\nruntime: claude-code\n");
    const failed = await reconcileAgentConfigs({
      clientId: "client-1",
      listPinnedAgents: async () => {
        throw new Error("server unavailable".repeat(10));
      },
    });
    expect(failed.ok).toBe(false);
    expect(failed.detail).toContain("server reconciliation failed");

    const failedString = await reconcileAgentConfigs({
      clientId: "client-1",
      listPinnedAgents: async () => {
        throw "server string failure";
      },
    });
    expect(failedString.ok).toBe(false);
    expect(failedString.detail).toContain("server string failure");

    writeAgent("missing-yaml", "");
    rmSync(join(home, "config", "agents", "missing-yaml", "agent.yaml"), { force: true });
    writeAgent("null-yaml", "null\n");
    writeAgent("bad-yaml", "agentId: [broken\n");
    const suspendedWithUnreadableAliases = await reconcileAgentConfigs({
      clientId: "client-1",
      listPinnedAgents: async () => [{ agentId: "agent-1", clientId: "client-1", status: "suspended" }],
    });
    expect(suspendedWithUnreadableAliases.detail).toContain("1 suspended/disabled");

    serviceStatusMock.mockReturnValueOnce({
      platform: "unsupported",
      label: "",
      unitPath: "",
      logDir: "/logs",
      state: "not-installed",
    });
    expect(checkBackgroundService()).toEqual({
      label: "Background service",
      ok: true,
      detail: `not supported on ${process.platform} — runs inline`,
    });

    serviceStatusMock.mockReturnValueOnce({
      platform: "systemd",
      label: "first-tree.service",
      unitPath: "/unit",
      logDir: "/logs",
      state: "active",
      detail: "pid 123",
    });
    expect(checkBackgroundService()).toEqual({
      label: "Background service",
      ok: true,
      detail: "running (systemd, pid 123); logs at /logs",
    });

    serviceStatusMock.mockReturnValueOnce({
      platform: "systemd",
      label: "first-tree.service",
      unitPath: "/unit",
      logDir: "/logs",
      state: "active",
    });
    expect(checkBackgroundService()).toEqual({
      label: "Background service",
      ok: true,
      detail: "running (systemd); logs at /logs",
    });

    serviceStatusMock.mockReturnValueOnce({
      platform: "launchd",
      label: "dev.first-tree",
      unitPath: "/unit",
      logDir: "/logs",
      state: "inactive",
      detail: "loaded",
    });
    expect(checkBackgroundService()).toEqual({
      label: "Background service",
      ok: false,
      detail: "installed but not running — loaded; unit at /unit",
    });

    serviceStatusMock.mockReturnValueOnce({
      platform: "launchd",
      label: "dev.first-tree",
      unitPath: "/unit",
      logDir: "/logs",
      state: "inactive",
    });
    expect(checkBackgroundService()).toEqual({
      label: "Background service",
      ok: false,
      detail: "installed but not running; unit at /unit",
    });

    serviceStatusMock.mockReturnValueOnce({
      platform: "task-scheduler",
      label: "\\FirstTree\\first-tree-dev",
      unitPath: "C:\\Users\\dev\\.first-tree-dev\\service\\first-tree-dev-task.xml",
      logDir: "/logs",
      state: "unknown",
      detail: "task running but no live service runtime marker",
    });
    expect(checkBackgroundService()).toEqual({
      label: "Background service",
      ok: false,
      detail:
        "state unknown (task-scheduler, task running but no live service runtime marker); unit at C:\\Users\\dev\\.first-tree-dev\\service\\first-tree-dev-task.xml",
    });

    serviceStatusMock.mockReturnValueOnce({
      platform: "launchd",
      label: "dev.first-tree",
      unitPath: "/unit",
      logDir: "/logs",
      state: "not-installed",
    });
    expect(checkBackgroundService()).toEqual({
      label: "Background service",
      ok: false,
      detail: "not installed — re-run `first-tree-dev login <code>` to install",
    });

    printResults([
      { label: "One", ok: true, detail: "ok" },
      { label: "Two", ok: false, detail: "bad" },
    ]);
    expect(stderrMock.mock.calls.map((call) => String(call[0])).join("")).toContain("1 issue(s) found.");

    stderrMock.mockClear();
    printResults([{ label: "One", ok: true, detail: "ok" }]);
    expect(stderrMock.mock.calls.map((call) => String(call[0])).join("")).toContain("All checks passed.");
  });

  it("formats runtime provider checks and handles empty capability snapshots", async () => {
    const { runtimeProviderCheck, runtimeProviderChecks } = await import("../core/doctor.js");

    expect(
      runtimeProviderCheck("codex", {
        state: "ok",
        available: true,
        detectedAt: "2026-01-01T00:00:00.000Z",
        runtimeSource: "path",
        sdkVersion: "1.2.3",
        latencyMs: 42,
      }),
    ).toEqual({
      label: "codex",
      ok: true,
      detail: "ok — installed, path, v1.2.3, 42ms",
    });
    expect(
      runtimeProviderCheck("claude-code", {
        state: "missing",
        available: false,
        detectedAt: "2026-01-01T00:00:00.000Z",
        error: "  not found  ",
      }),
    ).toEqual({
      label: "claude-code",
      ok: false,
      detail: "missing — not found",
    });
    expect(
      runtimeProviderCheck("other", {
        state: "error",
        available: false,
        detectedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toEqual({
      label: "other",
      ok: false,
      detail: "error",
    });
    expect(runtimeProviderChecks({})).toEqual([
      { label: "Runtime providers", ok: false, detail: "no providers probed" },
    ]);
    expect(
      runtimeProviderChecks({
        zed: { state: "ok", available: true, detectedAt: "2026-01-01T00:00:00.000Z" },
        codex: undefined,
        "claude-code": { state: "missing", available: false, detectedAt: "2026-01-01T00:00:00.000Z" },
      }).map((result) => result.label),
    ).toEqual(["claude-code", "zed"]);
  });
});
