import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cliFetchMock = vi.fn();
const defaultConfigDirMock = vi.fn<() => string>();
const ensureFreshAccessTokenMock = vi.fn<() => Promise<string>>();
const failMock = vi.fn();
const loadAgentsMock = vi.fn();
const printLineMock = vi.fn();
const resolveServerUrlMock = vi.fn<(value?: string) => string>();

function response(ok: boolean, status: number, body: unknown) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

async function loadCommand(): Promise<Command> {
  vi.doMock("@first-tree/shared/config", () => ({
    agentConfigSchema: {},
    defaultConfigDir: defaultConfigDirMock,
    loadAgents: loadAgentsMock,
  }));
  vi.doMock("../cli/output.js", () => ({
    fail: failMock,
  }));
  vi.doMock("../core/bootstrap.js", () => ({
    ensureFreshAccessToken: ensureFreshAccessTokenMock,
    resolveServerUrl: resolveServerUrlMock,
  }));
  vi.doMock("../core/cli-fetch.js", () => ({
    cliFetch: cliFetchMock,
  }));
  vi.doMock("../core/output.js", () => ({
    print: { line: printLineMock },
  }));

  const { registerAgentListCommand } = await import("../commands/agent/list.js");
  const program = new Command();
  program.exitOverride();
  registerAgentListCommand(program);
  return program;
}

describe("agent list command", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    defaultConfigDirMock.mockReturnValue("/home/test/.first-tree/config");
    ensureFreshAccessTokenMock.mockResolvedValue("access-token");
    failMock.mockImplementation((code: string, message: string) => {
      throw new Error(`${code}:${message}`);
    });
    resolveServerUrlMock.mockImplementation((value) => value ?? "https://hub.example.test");
  });

  it("prints local agent configs and treats missing local config as empty", async () => {
    const program = await loadCommand();
    loadAgentsMock.mockReturnValueOnce(
      new Map([
        ["atlas", { runtime: "claude-code", agentId: "agent-atlas" }],
        ["reviewer", { runtime: "codex", agentId: "agent-reviewer" }],
      ]),
    );

    await program.parseAsync(["list"], { from: "user" });

    let printed = printLineMock.mock.calls.flat().join("");
    expect(loadAgentsMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentsDir: "/home/test/.first-tree/config/agents" }),
    );
    expect(printed).toContain("atlas");
    expect(printed).toContain("uuid: agent-atlas");
    expect(printed).toContain("reviewer");

    printLineMock.mockClear();
    loadAgentsMock.mockImplementationOnce(() => {
      throw new Error("missing directory");
    });
    await program.parseAsync(["list"], { from: "user" });
    printed = printLineMock.mock.calls.flat().join("");
    expect(printed).toContain("No agents configured.");
  });

  it("prints remote managed agents and filters by organization", async () => {
    const program = await loadCommand();
    cliFetchMock.mockResolvedValueOnce(
      response(true, 200, [
        {
          uuid: "agent-1",
          name: "atlas",
          displayName: "Atlas",
          type: "agent",
          organizationId: "org-a",
          runtimeProvider: "claude-code",
          clientId: "client-a",
        },
        {
          uuid: "agent-2",
          name: null,
          displayName: "No Name",
          type: "human",
          organizationId: "org-b",
          runtimeProvider: "codex",
          clientId: null,
        },
      ]),
    );

    await program.parseAsync(["list", "--remote", "--org", "org-b", "--server", "https://override.example.test"], {
      from: "user",
    });

    expect(resolveServerUrlMock).toHaveBeenCalledWith("https://override.example.test");
    expect(cliFetchMock).toHaveBeenCalledWith(
      "https://override.example.test/api/v1/me/managed-agents",
      expect.objectContaining({ headers: { Authorization: "Bearer access-token" } }),
    );
    const printed = printLineMock.mock.calls.flat().join("");
    expect(printed).toContain("agent-2");
    expect(printed).toContain("org-b");
    expect(printed).not.toContain("atlas");
  });

  it("reports empty remote results and wraps remote fetch failures", async () => {
    const program = await loadCommand();
    cliFetchMock.mockResolvedValueOnce(response(true, 200, []));

    await program.parseAsync(["list", "--remote"], { from: "user" });
    expect(printLineMock.mock.calls.flat().join("")).toContain("No agents found.");

    cliFetchMock.mockResolvedValueOnce(response(false, 500, {}));
    await expect(program.parseAsync(["list", "--remote"], { from: "user" })).rejects.toThrow(
      "LIST_ERROR:LIST_ERROR:Server returned 500",
    );
  });
});
