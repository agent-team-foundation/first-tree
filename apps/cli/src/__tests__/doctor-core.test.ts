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
});

describe("doctor core checks", () => {
  it("checks config, server reachability, websocket reachability, and local agents", async () => {
    const { checkAgentConfigs, checkClientConfig, checkServerReachable, checkWebSocket, reconcileAgentConfigs } =
      await import("../core/doctor.js");

    expect(checkClientConfig()).toEqual({
      label: "Config",
      ok: false,
      detail: "no config file or env vars found",
    });

    process.env.FIRST_TREE_SERVER_URL = "http://env.test";
    expect(checkClientConfig()).toEqual({ label: "Config", ok: true, detail: "via environment variables" });

    writeFileSync(
      join(home, "config", "client.yaml"),
      "server:\n  url: http://hub.test\nclient:\n  id: client_1234abcd\n",
    );
    delete process.env.FIRST_TREE_SERVER_URL;
    expect(checkClientConfig().detail).toContain("client.yaml");

    cliFetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    await expect(checkServerReachable()).resolves.toEqual({ label: "Server URL", ok: true, detail: "http://hub.test" });

    cliFetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    await expect(checkServerReachable()).resolves.toEqual({
      label: "Server URL",
      ok: false,
      detail: "unhealthy (HTTP 503) at http://hub.test",
    });

    cliFetchMock.mockRejectedValueOnce(new Error("network"));
    await expect(checkWebSocket()).resolves.toEqual({
      label: "WebSocket",
      ok: false,
      detail: "server unreachable at http://hub.test",
    });

    cliFetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    await expect(checkWebSocket()).resolves.toEqual({
      label: "WebSocket",
      ok: true,
      detail: "ws://hub.test (server reachable)",
    });

    expect(checkAgentConfigs()).toEqual({ label: "Agents", ok: false, detail: "no agents configured" });
    writeAgent("kael", "agentId: agent-1\nruntime: claude-code\n");
    expect(checkAgentConfigs()).toEqual({ label: "Agents", ok: true, detail: "1 configured (kael)" });

    await expect(
      reconcileAgentConfigs({
        clientId: "client-1",
        listPinnedAgents: async () => [{ agentId: "agent-1", clientId: "client-1" }],
      }),
    ).resolves.toEqual({ label: "Agents", ok: true, detail: "1 configured, all pinned to this client" });

    writeAgent("moved", "agentId: agent-2\nruntime: claude-code\n");
    const stale = await reconcileAgentConfigs({
      clientId: "client-1",
      listPinnedAgents: async () => [{ agentId: "agent-2", clientId: "client-2" }],
    });
    expect(stale.ok).toBe(false);
    expect(stale.detail).toContain("moved [pinned to another client: client-2]");
    expect(stale.detail).toContain("run `first-tree agent prune`");
  });

  it("handles reconciliation failures and background-service states", async () => {
    const { checkBackgroundService, printResults, reconcileAgentConfigs } = await import("../core/doctor.js");

    await expect(
      reconcileAgentConfigs({
        clientId: "client-1",
        agentsDir: join(home, "missing-agents"),
        listPinnedAgents: async () => [],
      }),
    ).resolves.toEqual({ label: "Agents", ok: false, detail: "no agents configured" });

    writeAgent("kael", "agentId: agent-1\nruntime: claude-code\n");
    const failed = await reconcileAgentConfigs({
      clientId: "client-1",
      listPinnedAgents: async () => {
        throw new Error("hub unavailable".repeat(10));
      },
    });
    expect(failed.ok).toBe(false);
    expect(failed.detail).toContain("server reconciliation failed");

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
      state: "not-installed",
    });
    expect(checkBackgroundService()).toEqual({
      label: "Background service",
      ok: false,
      detail: "not installed — re-run `first-tree login <token>` to install",
    });

    printResults([
      { label: "One", ok: true, detail: "ok" },
      { label: "Two", ok: false, detail: "bad" },
    ]);
    expect(stderrMock.mock.calls.map((call) => String(call[0])).join("")).toContain("1 issue(s) found.");
  });
});
