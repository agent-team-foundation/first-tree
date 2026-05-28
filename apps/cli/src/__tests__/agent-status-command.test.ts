import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cliFetchMock = vi.fn();
const ensureFreshAccessTokenMock = vi.fn<() => Promise<string>>();
const failMock = vi.fn();
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

  const { registerAgentStatusCommand } = await import("../commands/agent/status.js");
  const program = new Command();
  program.exitOverride();
  registerAgentStatusCommand(program);
  return program;
}

describe("agent status command", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    ensureFreshAccessTokenMock.mockResolvedValue("access-token");
    failMock.mockImplementation((code: string, message: string) => {
      throw new Error(`${code}:${message}`);
    });
    resolveServerUrlMock.mockImplementation((value) => value ?? "https://hub.example.test");
  });

  it("aggregates activity across every membership and prints the table view", async () => {
    const program = await loadCommand();
    cliFetchMock
      .mockResolvedValueOnce(
        response(true, 200, {
          memberships: [{ organizationId: "org-a" }, { organizationId: "org-b" }],
        }),
      )
      .mockResolvedValueOnce(
        response(true, 200, {
          total: 2,
          running: 1,
          byState: { idle: 1, working: 1, blocked: 0, error: 0 },
          clients: 1,
          agents: [
            {
              agentId: "atlas",
              clientId: "client-a",
              runtimeType: "claude-code",
              runtimeState: "working",
              activeSessions: 1,
              totalSessions: 2,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response(true, 200, {
          total: 1,
          running: 1,
          byState: { idle: 0, working: 0, blocked: 1, error: 0 },
          clients: 2,
          agents: [
            {
              agentId: "reviewer",
              clientId: null,
              runtimeType: null,
              runtimeState: "blocked",
              activeSessions: null,
              totalSessions: null,
            },
          ],
        }),
      );

    await program.parseAsync(["status"], { from: "user" });

    expect(cliFetchMock).toHaveBeenCalledWith(
      "https://hub.example.test/api/v1/me",
      expect.objectContaining({ headers: { Authorization: "Bearer access-token" } }),
    );
    expect(cliFetchMock).toHaveBeenCalledWith(
      "https://hub.example.test/api/v1/orgs/org-a/activity",
      expect.objectContaining({ headers: { Authorization: "Bearer access-token" } }),
    );
    expect(cliFetchMock).toHaveBeenCalledWith(
      "https://hub.example.test/api/v1/orgs/org-b/activity",
      expect.objectContaining({ headers: { Authorization: "Bearer access-token" } }),
    );

    const printed = printLineMock.mock.calls.flat().join("");
    expect(printed).toContain("Clients: 3 connected");
    expect(printed).toContain("Agents: 2 running / 3 total");
    expect(printed).toContain("atlas");
    expect(printed).toContain("reviewer");
    expect(printed).toContain("1/2");
  });

  it("prints one named agent and reports a missing named agent without failing", async () => {
    const program = await loadCommand();
    cliFetchMock
      .mockResolvedValueOnce(response(true, 200, { memberships: [{ organizationId: "org-a" }] }))
      .mockResolvedValueOnce(
        response(true, 200, {
          total: 1,
          running: 1,
          byState: { idle: 0, working: 1, blocked: 0, error: 0 },
          clients: 1,
          agents: [
            {
              agentId: "atlas",
              clientId: "client-a",
              runtimeType: "codex",
              runtimeState: "working",
              activeSessions: 3,
              totalSessions: 5,
            },
          ],
        }),
      );

    await program.parseAsync(["status", "atlas", "--server", "https://override.example.test"], {
      from: "user",
    });

    expect(resolveServerUrlMock).toHaveBeenCalledWith("https://override.example.test");
    let printed = printLineMock.mock.calls.flat().join("");
    expect(printed).toContain("Agent: atlas");
    expect(printed).toContain("Runtime: codex");
    expect(printed).toContain("Sessions: 3 active / 5 total");
    expect(printed).toContain("Client: client-a");

    printLineMock.mockClear();
    cliFetchMock
      .mockResolvedValueOnce(response(true, 200, { memberships: [{ organizationId: "org-a" }] }))
      .mockResolvedValueOnce(
        response(true, 200, {
          total: 0,
          running: 0,
          byState: { idle: 0, working: 0, blocked: 0, error: 0 },
          clients: 0,
          agents: [],
        }),
      );

    await program.parseAsync(["status", "missing"], { from: "user" });

    printed = printLineMock.mock.calls.flat().join("");
    expect(printed).toContain('Agent "missing" is not running.');
    expect(failMock).not.toHaveBeenCalled();
  });

  it("fails when /me cannot be fetched and skips orgs that fail", async () => {
    const program = await loadCommand();
    cliFetchMock.mockResolvedValueOnce(response(false, 503, {}));

    await expect(program.parseAsync(["status"], { from: "user" })).rejects.toThrow(
      "STATUS_ERROR:FETCH_ERROR:/me HTTP 503",
    );

    failMock.mockClear();
    printLineMock.mockClear();
    cliFetchMock
      .mockResolvedValueOnce(
        response(true, 200, {
          memberships: [{ organizationId: "org-a" }, { organizationId: "org-b" }],
        }),
      )
      .mockResolvedValueOnce(response(false, 500, {}))
      .mockResolvedValueOnce(
        response(true, 200, {
          total: 1,
          running: 0,
          byState: { idle: 1, working: 0, blocked: 0, error: 0 },
          clients: 1,
          agents: [],
        }),
      );

    await program.parseAsync(["status"], { from: "user" });

    const printed = printLineMock.mock.calls.flat().join("");
    expect(printed).toContain("Clients: 1 connected");
    expect(failMock).not.toHaveBeenCalled();
  });
});
