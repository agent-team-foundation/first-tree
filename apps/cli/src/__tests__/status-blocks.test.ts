import { describe, expect, it, vi } from "vitest";

type ServiceStatus = {
  detail?: string;
  label: string;
  platform: string;
  state: string;
};

type Credentials = {
  accessToken: string;
  refreshToken: string;
} | null;

const { lines, mocks } = vi.hoisted(() => ({
  lines: [] as string[],
  mocks: {
    defaultConfigDir: vi.fn(() => "/tmp/first-tree-status/config"),
    existsSync: vi.fn(() => false),
    getClientServiceStatus: vi.fn<() => ServiceStatus>(() => ({
      label: "first-tree-dev.service",
      platform: "systemd",
      state: "not-installed",
    })),
    isServiceSupported: vi.fn(() => true),
    loadAgents: vi.fn(() => new Map()),
    loadCredentials: vi.fn<() => Credentials>(() => null),
    readConfigFile: vi.fn(() => ({})),
  },
}));

vi.mock("node:fs", () => ({
  existsSync: mocks.existsSync,
}));

vi.mock("@first-tree/shared/config", () => ({
  agentConfigSchema: {},
  defaultConfigDir: mocks.defaultConfigDir,
  loadAgents: mocks.loadAgents,
  readConfigFile: mocks.readConfigFile,
}));

vi.mock("../core/bootstrap.js", () => ({
  loadCredentials: mocks.loadCredentials,
}));

vi.mock("../core/output.js", () => ({
  print: {
    line: (value: string) => lines.push(value),
  },
}));

vi.mock("../core/service-install.js", () => ({
  getClientServiceStatus: mocks.getClientServiceStatus,
  isServiceSupported: mocks.isServiceSupported,
}));

vi.mock("../core/version.js", () => ({
  COMMAND_VERSION: "9.8.7-test",
}));

function compactOutput(): string {
  return lines.join("");
}

function resetMocks(): void {
  lines.length = 0;
  mocks.defaultConfigDir.mockReturnValue("/tmp/first-tree-status/config");
  mocks.existsSync.mockReturnValue(false);
  mocks.getClientServiceStatus.mockReturnValue({
    label: "first-tree-dev.service",
    platform: "systemd",
    state: "not-installed",
  });
  mocks.isServiceSupported.mockReturnValue(true);
  mocks.loadAgents.mockReturnValue(new Map());
  mocks.loadCredentials.mockReturnValue(null);
  mocks.readConfigFile.mockReturnValue({});
}

function jwtWithExp(exp: number): string {
  const payload = Buffer.from(JSON.stringify({ exp }), "utf-8").toString("base64url");
  return `header.${payload}.signature`;
}

describe("status render blocks", () => {
  it("renders CLI version, service states, and hub config states", async () => {
    resetMocks();
    const { renderCliVersionBlock, renderHubBlock, renderServiceBlock } = await import(
      "../commands/_shared/status-blocks.js"
    );

    renderCliVersionBlock();
    expect(compactOutput()).toContain("CLI:      9.8.7-test");

    lines.length = 0;
    mocks.isServiceSupported.mockReturnValue(false);
    renderServiceBlock();
    expect(compactOutput()).toContain("not supported");

    lines.length = 0;
    mocks.isServiceSupported.mockReturnValue(true);
    mocks.getClientServiceStatus.mockReturnValue({
      detail: "pid 42",
      label: "first-tree-dev.service",
      platform: "systemd",
      state: "active",
    });
    renderServiceBlock();
    expect(compactOutput()).toContain("running (systemd, pid 42)");
    expect(compactOutput()).toContain("journalctl --user -u first-tree-dev -f");

    lines.length = 0;
    mocks.getClientServiceStatus.mockReturnValue({
      detail: "exit 1",
      label: "x",
      platform: "launchd",
      state: "inactive",
    });
    renderServiceBlock();
    expect(compactOutput()).toContain("stopped (launchd, exit 1)");

    lines.length = 0;
    mocks.getClientServiceStatus.mockReturnValue({ label: "x", platform: "launchd", state: "unknown" });
    renderServiceBlock();
    expect(compactOutput()).toContain("unknown (launchd)");

    lines.length = 0;
    renderHubBlock();
    expect(compactOutput()).toContain("not configured");

    lines.length = 0;
    mocks.existsSync.mockReturnValue(true);
    mocks.readConfigFile.mockReturnValue({ client: { id: "client-1" }, server: { url: "https://hub.example" } });
    renderHubBlock();
    expect(compactOutput()).toContain("Hub:      https://hub.example");
    expect(compactOutput()).toContain("Client:   client-1");

    lines.length = 0;
    mocks.readConfigFile.mockImplementationOnce(() => {
      throw new Error("bad yaml in client config that should be shortened");
    });
    renderHubBlock();
    expect(compactOutput()).toContain("could not read /tmp/first-tree-status/config/client.yaml");
  });

  it("renders auth token health and configured agents", async () => {
    resetMocks();
    const { renderAgentsBlock, renderAuthBlock } = await import("../commands/_shared/status-blocks.js");

    renderAuthBlock();
    expect(compactOutput()).toContain("no credentials");

    lines.length = 0;
    mocks.loadCredentials.mockReturnValue({ accessToken: "access", refreshToken: "not-a-jwt" });
    renderAuthBlock();
    expect(compactOutput()).toContain("could not parse refresh token");

    lines.length = 0;
    const now = Math.floor(Date.now() / 1000);
    mocks.loadCredentials.mockReturnValue({ accessToken: "access", refreshToken: jwtWithExp(now - 10) });
    renderAuthBlock();
    expect(compactOutput()).toContain("refresh token EXPIRED");

    lines.length = 0;
    mocks.loadCredentials.mockReturnValue({ accessToken: "access", refreshToken: jwtWithExp(now + 3600) });
    renderAuthBlock();
    expect(compactOutput()).toContain("expires in ~1h");

    lines.length = 0;
    mocks.loadCredentials.mockReturnValue({ accessToken: "access", refreshToken: jwtWithExp(now + 7 * 86400) });
    renderAuthBlock();
    expect(compactOutput()).toContain("valid for ~7d");

    lines.length = 0;
    renderAgentsBlock();
    expect(compactOutput()).toContain("Agents:   0 configured");

    lines.length = 0;
    mocks.loadAgents.mockReturnValue(
      new Map([
        ["alice", { agentId: "agent-1", runtime: "codex" }],
        ["bob", { agentId: "agent-2", runtime: "claude-code" }],
      ]),
    );
    renderAgentsBlock();
    expect(compactOutput()).toContain("Agents:   2 configured");
    expect(compactOutput()).toContain("alice");
    expect(compactOutput()).toContain("agentId: agent-2");

    lines.length = 0;
    mocks.loadAgents.mockImplementationOnce(() => {
      throw new Error("missing agents");
    });
    renderAgentsBlock();
    expect(compactOutput()).toContain("no agents directory");
  });
});
