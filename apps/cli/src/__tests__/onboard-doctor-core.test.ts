import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

const printLineMock = vi.fn();
const printStatusMock = vi.fn();
const cliFetchMock = vi.fn<(...args: unknown[]) => Promise<FetchResponse>>();
const ensureFreshAccessTokenMock = vi.fn<() => Promise<string>>();
const loadCredentialsMock = vi.fn<() => { serverUrl: string } | null>();
const resolveServerUrlMock = vi.fn<(server?: string) => string>();
const saveAgentConfigMock = vi.fn();
const bindFeishuBotMock = vi.fn<(...args: unknown[]) => Promise<void>>();

function response(ok: boolean, status: number, body: unknown = {}): FetchResponse {
  return {
    ok,
    status,
    json: async () => body,
  };
}

describe("onboard core helpers", () => {
  let tmp: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    tmp = mkdtempSync(join(tmpdir(), "first-tree-onboard-core-"));
    originalHome = process.env.FIRST_TREE_HOME;
    process.env.FIRST_TREE_HOME = tmp;

    ensureFreshAccessTokenMock.mockResolvedValue("access-token");
    loadCredentialsMock.mockReturnValue({ serverUrl: "https://hub.example.test" });
    resolveServerUrlMock.mockImplementation((server) => server ?? "https://hub.example.test");
    cliFetchMock.mockImplementation(async (url: unknown, init?: unknown) => {
      const href = String(url);
      if (href.endsWith("/api/v1/health")) return response(true, 200);
      if (href.endsWith("/api/v1/me")) {
        return response(true, 200, {
          defaultOrganizationId: "org-1",
          memberships: [
            { organizationId: "org-1", organizationName: "Compute" },
            { organizationId: "org-2", organizationName: "Research" },
          ],
        });
      }
      if (href.endsWith("/api/v1/orgs/org-1/agents")) {
        const parsed = typeof init === "object" && init !== null && "body" in init ? JSON.parse(String(init.body)) : {};
        return response(true, 201, {
          uuid: parsed.type === "human" ? "human-uuid" : "agent-uuid",
          name: parsed.name,
        });
      }
      return response(false, 404, { error: "missing" });
    });

    vi.doMock("../core/bootstrap.js", () => ({
      ensureFreshAccessToken: ensureFreshAccessTokenMock,
      loadCredentials: loadCredentialsMock,
      resolveServerUrl: resolveServerUrlMock,
      saveAgentConfig: saveAgentConfigMock,
    }));
    vi.doMock("../core/cli-fetch.js", () => ({ cliFetch: cliFetchMock }));
    vi.doMock("../core/output.js", () => ({
      print: { line: printLineMock, status: printStatusMock },
    }));
    vi.doMock("../core/feishu.js", () => ({ bindFeishuBot: bindFeishuBotMock }));
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.FIRST_TREE_HOME;
    else process.env.FIRST_TREE_HOME = originalHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("saves state, checks prerequisites, and formats reports", async () => {
    const { formatCheckReport, loadOnboardState, onboardCheck, saveOnboardState } = await import("../core/onboard.js");

    expect(loadOnboardState()).toBeNull();
    saveOnboardState({ id: "ada", type: "human" });
    expect(loadOnboardState()).toEqual({ id: "ada", type: "human" });

    const okItems = await onboardCheck({ id: "ada", type: "human", server: "https://hub.example.test" });
    expect(okItems.map((item) => [item.key, item.status])).toContainEqual(["connect", "ok"]);
    expect(okItems.map((item) => [item.key, item.status])).toContainEqual(["server_reachable", "ok"]);
    expect(formatCheckReport(okItems)).toContain("Signed in");

    loadCredentialsMock.mockReturnValueOnce(null);
    resolveServerUrlMock.mockImplementationOnce(() => {
      throw new Error("missing server");
    });
    const missingItems = await onboardCheck({ id: "", type: "agent" });
    expect(missingItems.map((item) => [item.key, item.status])).toContainEqual(["connect", "missing_required"]);
    expect(missingItems.map((item) => [item.key, item.status])).toContainEqual(["server", "missing_required"]);
    expect(missingItems.map((item) => [item.key, item.status])).toContainEqual(["client", "ok"]);
  });

  it("creates human and assistant agents, binds Feishu, and writes local config", async () => {
    const { onboardCreate } = await import("../core/onboard.js");

    await onboardCreate({
      assistant: "ada-helper",
      clientId: "client-1",
      displayName: "Ada Lovelace",
      domains: "runtime, docs",
      feishuBotAppId: "bot-id",
      feishuBotAppSecret: "bot-secret",
      id: "ada",
      role: "admin",
      server: "https://hub.example.test/",
      type: "human",
    });

    expect(cliFetchMock).toHaveBeenCalledWith(
      "https://hub.example.test/api/v1/orgs/org-1/agents",
      expect.objectContaining({ method: "POST" }),
    );
    expect(saveAgentConfigMock).toHaveBeenCalledWith("ada-helper", "agent-uuid", "claude-code");
    expect(bindFeishuBotMock).toHaveBeenCalledWith(
      "https://hub.example.test",
      "access-token",
      "agent-uuid",
      "bot-id",
      "bot-secret",
    );
    expect(printLineMock.mock.calls.flat().join("")).toContain("Onboard complete");
  });

  it("surfaces create failures and continues when optional assistant creation fails", async () => {
    const { onboardCreate } = await import("../core/onboard.js");

    cliFetchMock.mockImplementationOnce(async () =>
      response(true, 200, { defaultOrganizationId: null, memberships: [{ organizationId: "org-1" }] }),
    );
    cliFetchMock.mockImplementationOnce(async () => response(false, 500, { error: "primary rejected" }));
    await expect(onboardCreate({ id: "bot", type: "agent" })).rejects.toThrow("primary rejected");

    cliFetchMock.mockImplementation(async (url: unknown, init?: unknown) => {
      const href = String(url);
      if (href.endsWith("/api/v1/me")) {
        return response(true, 200, { defaultOrganizationId: null, memberships: [{ organizationId: "org-1" }] });
      }
      if (href.endsWith("/api/v1/orgs/org-1/agents")) {
        const body = typeof init === "object" && init !== null && "body" in init ? String(init.body) : "";
        const parsed = JSON.parse(body);
        if (parsed.name === "helper") return response(false, 409, { error: "assistant exists" });
        return response(true, 201, { uuid: "human-uuid", name: "ada" });
      }
      return response(true, 200);
    });

    await onboardCreate({ assistant: "helper", id: "ada", type: "human" });
    expect(printLineMock.mock.calls.flat().join("")).toContain("Failed to create assistant");
  });
});

describe("doctor core helpers", () => {
  let tmp: string;
  let originalServerUrl: string | undefined;
  let configDir: string;
  let readonlyConfig: Record<string, unknown>;
  const loadAgentsMock = vi.fn<() => Map<string, unknown>>();
  const findStaleAliasesMock = vi.fn<() => Promise<unknown[]>>();
  const serviceStatusMock = vi.fn<() => Record<string, unknown>>();

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    tmp = mkdtempSync(join(tmpdir(), "first-tree-doctor-core-"));
    configDir = join(tmp, "config");
    readonlyConfig = { server: { url: "https://hub.example.test" } };
    originalServerUrl = process.env.FIRST_TREE_SERVER_URL;
    delete process.env.FIRST_TREE_SERVER_URL;

    cliFetchMock.mockResolvedValue(response(true, 200));
    loadAgentsMock.mockReturnValue(new Map([["atlas", { agentId: "agent-1" }]]));
    findStaleAliasesMock.mockResolvedValue([]);
    serviceStatusMock.mockReturnValue({ platform: "systemd", state: "active", detail: "pid 42", logDir: "/logs" });

    vi.doMock("@first-tree/shared/config", () => ({
      agentConfigSchema: {},
      clientConfigSchema: {},
      defaultConfigDir: () => configDir,
      loadAgents: loadAgentsMock,
      resolveConfigReadonly: () => readonlyConfig,
    }));
    vi.doMock("../core/agent-prune.js", () => ({
      findStaleAliases: findStaleAliasesMock,
      formatStaleReason: (reason: string) => reason.replace(/_/g, " "),
    }));
    vi.doMock("../core/cli-fetch.js", () => ({ cliFetch: cliFetchMock }));
    vi.doMock("../core/output.js", () => ({
      blank: vi.fn(),
      print: { line: printLineMock, status: printStatusMock },
    }));
    vi.doMock("../core/service-install.js", () => ({ getClientServiceStatus: serviceStatusMock }));
  });

  afterEach(() => {
    if (originalServerUrl === undefined) delete process.env.FIRST_TREE_SERVER_URL;
    else process.env.FIRST_TREE_SERVER_URL = originalServerUrl;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("checks local config, agents, server, websocket, and service state", async () => {
    const doctor = await import("../core/doctor.js");

    expect(doctor.checkNodeVersion().label).toBe("Node.js");
    expect(doctor.checkClientConfig()).toMatchObject({ ok: false, detail: "no config file or env vars found" });

    process.env.FIRST_TREE_SERVER_URL = "https://env.example.test";
    expect(doctor.checkClientConfig()).toMatchObject({ ok: true, detail: "via environment variables" });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "client.yaml"), "server:\n  url: https://hub.example.test\n");
    expect(doctor.checkClientConfig()).toMatchObject({ ok: true, detail: "config file + env vars" });

    expect(await doctor.checkServerReachable()).toMatchObject({ ok: true, detail: "https://hub.example.test" });
    cliFetchMock.mockResolvedValueOnce(response(false, 503));
    expect(await doctor.checkServerReachable()).toMatchObject({
      ok: false,
      detail: "unhealthy (HTTP 503) at https://hub.example.test",
    });
    cliFetchMock.mockRejectedValueOnce(new Error("offline"));
    expect(await doctor.checkWebSocket()).toMatchObject({
      ok: false,
      detail: "server unreachable at https://hub.example.test",
    });

    expect(doctor.checkAgentConfigs()).toMatchObject({ ok: false, detail: "no agents configured" });
    mkdirSync(join(configDir, "agents"), { recursive: true });
    expect(doctor.checkAgentConfigs()).toMatchObject({ ok: true, detail: "1 configured (atlas)" });
    loadAgentsMock.mockImplementationOnce(() => {
      throw new Error("bad yaml");
    });
    expect(doctor.checkAgentConfigs()).toMatchObject({ ok: false, detail: "error reading agent configs" });

    expect(doctor.checkBackgroundService()).toMatchObject({
      ok: true,
      detail: "running (systemd, pid 42); logs at /logs",
    });
    serviceStatusMock.mockReturnValueOnce({
      platform: "launchd",
      state: "inactive",
      detail: "exited",
      unitPath: "/unit",
    });
    expect(doctor.checkBackgroundService()).toMatchObject({
      ok: false,
      detail: "installed but not running — exited; unit at /unit",
    });
    serviceStatusMock.mockReturnValueOnce({ platform: "unsupported", state: "not-installed" });
    expect(doctor.checkBackgroundService()).toMatchObject({
      ok: true,
      detail: expect.stringContaining("not supported on"),
    });
  });

  it("reconciles local aliases and prints summaries", async () => {
    const doctor = await import("../core/doctor.js");
    const agentsDir = join(configDir, "agents");
    mkdirSync(join(agentsDir, "atlas"), { recursive: true });
    mkdirSync(join(agentsDir, "stale"), { recursive: true });

    expect(
      await doctor.reconcileAgentConfigs({ agentsDir, clientId: "client-1", listPinnedAgents: async () => [] }),
    ).toMatchObject({ ok: true, detail: "2 configured, all pinned to this client" });

    findStaleAliasesMock.mockResolvedValueOnce([
      { name: "stale", reason: "pinned_elsewhere" },
      { name: "orphan", reason: "unowned" },
    ]);
    expect(
      await doctor.reconcileAgentConfigs({ agentsDir, clientId: "client-1", listPinnedAgents: async () => [] }),
    ).toMatchObject({
      ok: false,
      detail: expect.stringContaining("2 stale: stale [pinned elsewhere]; orphan [unowned]"),
    });

    findStaleAliasesMock.mockRejectedValueOnce(new Error("network unavailable and credentials expired"));
    expect(
      await doctor.reconcileAgentConfigs({ agentsDir, clientId: "client-1", listPinnedAgents: async () => [] }),
    ).toMatchObject({ ok: false, detail: expect.stringContaining("server reconciliation failed") });

    doctor.printResults([
      { label: "A", ok: true, detail: "ready" },
      { label: "B", ok: false, detail: "missing" },
    ]);
    const printed = printLineMock.mock.calls.flat().join("");
    expect(printed).toContain("A");
    expect(printed).toContain("1 issue(s) found");
  });

  it("handles missing server settings", async () => {
    readonlyConfig = { server: {} };
    const doctor = await import("../core/doctor.js");

    expect(await doctor.checkServerReachable()).toMatchObject({
      ok: false,
      detail: "not configured (FIRST_TREE_SERVER_URL or config file)",
    });
    expect(await doctor.checkWebSocket()).toMatchObject({ ok: false, detail: "cannot check (no server URL)" });
  });
});
