import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const credentialsMock = vi.hoisted(() => vi.fn());
const serviceSupportedMock = vi.hoisted(() => vi.fn());
const serviceStatusMock = vi.hoisted(() => vi.fn());
const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

vi.mock("../core/bootstrap.js", () => ({
  loadCredentials: credentialsMock,
}));

vi.mock("../core/service-install.js", () => ({
  getClientServiceStatus: serviceStatusMock,
  isServiceSupported: serviceSupportedMock,
}));

const originalHome = process.env.FIRST_TREE_HOME;
let home: string;

beforeEach(() => {
  home = join(tmpdir(), `ft-status-blocks-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(home, "config"), { recursive: true });
  process.env.FIRST_TREE_HOME = home;
  credentialsMock.mockReset();
  serviceSupportedMock.mockReset();
  serviceStatusMock.mockReset();
  stderrSpy.mockClear();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalHome;
});

function output(): string {
  return stderrSpy.mock.calls.map((call) => String(call[0])).join("");
}

function refreshTokenWithExp(exp: number): string {
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `header.${payload}.signature`;
}

describe("status block renderers", () => {
  it("renders CLI version, unsupported services, and service states", async () => {
    const { renderCliVersionBlock, renderServiceBlock } = await import("../commands/_shared/status-blocks.js");

    renderCliVersionBlock();
    expect(output()).toContain("CLI:");

    serviceSupportedMock.mockReturnValueOnce(false);
    renderServiceBlock();
    expect(output()).toContain(`not supported on ${process.platform}`);

    stderrSpy.mockClear();
    serviceSupportedMock.mockReturnValue(true);
    for (const [state, expected] of [
      ["active", "running"],
      ["inactive", "stopped"],
      ["not-installed", "not installed"],
      ["unknown", "unknown"],
    ] as const) {
      serviceStatusMock.mockReturnValueOnce({
        platform: state === "active" ? "systemd" : "launchd",
        label: state === "active" ? "first-tree-dev.service" : "dev.first-tree",
        state,
        detail: state === "active" ? "pid 123" : "",
      });
      renderServiceBlock();
      expect(output()).toContain(expected);
    }
    expect(output()).toContain("journalctl --user -u first-tree-dev -f");
  });

  it("renders server configuration states", async () => {
    const { renderHubBlock } = await import("../commands/_shared/status-blocks.js");

    renderHubBlock();
    expect(output()).toContain("not configured");

    stderrSpy.mockClear();
    writeFileSync(
      join(home, "config", "client.yaml"),
      "server:\n  url: https://first-tree.example\nclient:\n  id: client-1\n",
    );
    renderHubBlock();
    expect(output()).toContain("https://first-tree.example");
    expect(output()).toContain("client-1");

    stderrSpy.mockClear();
    writeFileSync(join(home, "config", "client.yaml"), "server: [");
    renderHubBlock();
    expect(output()).toContain("could not read");
  });

  it("renders auth token states", async () => {
    const { renderAuthBlock } = await import("../commands/_shared/status-blocks.js");
    const now = Math.floor(Date.now() / 1000);

    credentialsMock.mockReturnValueOnce(null);
    renderAuthBlock();
    expect(output()).toContain("no credentials");

    stderrSpy.mockClear();
    credentialsMock.mockReturnValueOnce({ refreshToken: "bad-token" });
    renderAuthBlock();
    expect(output()).toContain("could not parse refresh token");

    stderrSpy.mockClear();
    credentialsMock.mockReturnValueOnce({ refreshToken: refreshTokenWithExp(now - 10) });
    renderAuthBlock();
    expect(output()).toContain("refresh token EXPIRED");

    stderrSpy.mockClear();
    credentialsMock.mockReturnValueOnce({ refreshToken: refreshTokenWithExp(now + 3600) });
    renderAuthBlock();
    expect(output()).toContain("expires in ~1h");

    stderrSpy.mockClear();
    credentialsMock.mockReturnValueOnce({ refreshToken: refreshTokenWithExp(now + 5 * 86400) });
    renderAuthBlock();
    expect(output()).toContain("valid for ~5d");
  });

  it("renders agent configuration counts and entries", async () => {
    const { renderAgentsBlock } = await import("../commands/_shared/status-blocks.js");

    renderAgentsBlock();
    expect(output()).toContain("0 configured");

    stderrSpy.mockClear();
    const agentDir = join(home, "config", "agents", "nova");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "agent.yaml"), "agentId: agent-1\nruntime: claude-code\n");
    renderAgentsBlock();
    expect(output()).toContain("1 configured");
    expect(output()).toContain("nova");
    expect(output()).toContain("agent-1");
  });
});
