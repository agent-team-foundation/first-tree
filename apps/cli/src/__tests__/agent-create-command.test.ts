import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cliFetchMock = vi.fn();
const ensureFreshAccessTokenMock = vi.fn();
const failMock = vi.fn();
const printLineMock = vi.fn();
const resolveServerUrlMock = vi.fn();
const saveAgentConfigMock = vi.fn();

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
    saveAgentConfig: saveAgentConfigMock,
  }));
  vi.doMock("../core/cli-fetch.js", () => ({
    cliFetch: cliFetchMock,
  }));
  vi.doMock("../core/output.js", () => ({
    print: { line: printLineMock },
  }));

  const { registerAgentCreateCommand } = await import("../commands/agent/create.js");
  const program = new Command();
  program.exitOverride();
  registerAgentCreateCommand(program);
  return program;
}

describe("agent create command", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    ensureFreshAccessTokenMock.mockResolvedValue("access-token");
    failMock.mockImplementation((code: string, message: string) => {
      throw new Error(`${code}:${message}`);
    });
    resolveServerUrlMock.mockReturnValue("https://hub.example.test");
    saveAgentConfigMock.mockReturnValue("/home/test/.first-tree/config/agents/atlas");
  });

  it("creates an agent in a single-org account and saves local config", async () => {
    const program = await loadCommand();
    cliFetchMock
      .mockResolvedValueOnce(
        response(true, 200, {
          memberships: [{ organizationId: "org-1", organizationName: "Org One", role: "admin" }],
        }),
      )
      .mockResolvedValueOnce(response(true, 201, { uuid: "agent-1", name: "atlas" }));

    await program.parseAsync(
      [
        "create",
        "atlas",
        "--type",
        "agent",
        "--client-id",
        "client-1",
        "--runtime",
        "codex",
        "--display-name",
        "Atlas",
      ],
      { from: "user" },
    );

    expect(cliFetchMock).toHaveBeenNthCalledWith(
      2,
      "https://hub.example.test/api/v1/orgs/org-1/agents",
      expect.objectContaining({
        body: JSON.stringify({
          name: "atlas",
          type: "agent",
          clientId: "client-1",
          runtimeProvider: "codex",
          displayName: "Atlas",
        }),
        method: "POST",
      }),
    );
    expect(saveAgentConfigMock).toHaveBeenCalledWith("atlas", "agent-1", "codex");
    expect(printLineMock.mock.calls.flat().join("")).toContain("Agent ready");
  });

  it("honors an explicit organization and rejects organizations outside the caller memberships", async () => {
    const program = await loadCommand();
    cliFetchMock
      .mockResolvedValueOnce(
        response(true, 200, {
          memberships: [
            { organizationId: "org-1", organizationName: "Org One", role: "admin" },
            { organizationId: "org-2", organizationName: "Org Two", role: "member" },
          ],
        }),
      )
      .mockResolvedValueOnce(response(true, 201, { uuid: "agent-2", name: null }));

    await program.parseAsync(["create", "reviewer", "--type", "agent", "--client-id", "client-1", "--org", "org-2"], {
      from: "user",
    });

    expect(cliFetchMock).toHaveBeenNthCalledWith(
      2,
      "https://hub.example.test/api/v1/orgs/org-2/agents",
      expect.any(Object),
    );

    cliFetchMock.mockResolvedValueOnce(
      response(true, 200, {
        memberships: [{ organizationId: "org-1", organizationName: "Org One", role: "admin" }],
      }),
    );
    await expect(
      program.parseAsync(["create", "ghost", "--type", "agent", "--client-id", "client-1", "--org", "org-x"], {
        from: "user",
      }),
    ).rejects.toThrow('CREATE_ERROR:ORG_NOT_FOUND:Not an active member of organization "org-x"');
  });

  it("reports /me failures, missing organization context, and create API errors", async () => {
    const program = await loadCommand();

    cliFetchMock.mockResolvedValueOnce(response(false, 500, {}));
    await expect(
      program.parseAsync(["create", "atlas", "--type", "agent", "--client-id", "client-1"], { from: "user" }),
    ).rejects.toThrow("CREATE_ERROR:FETCH_ERROR:Failed to fetch /me: HTTP 500");

    cliFetchMock.mockResolvedValueOnce(response(true, 200, { memberships: [] }));
    await expect(
      program.parseAsync(["create", "atlas", "--type", "agent", "--client-id", "client-1"], { from: "user" }),
    ).rejects.toThrow("CREATE_ERROR:NO_ORG:You don't belong to any organization");

    cliFetchMock.mockResolvedValueOnce(
      response(true, 200, {
        memberships: [
          { organizationId: "org-1", organizationName: "Org One", role: "admin" },
          { organizationId: "org-2", organizationName: "Org Two", role: "member" },
        ],
      }),
    );
    await expect(
      program.parseAsync(["create", "atlas", "--type", "agent", "--client-id", "client-1"], { from: "user" }),
    ).rejects.toThrow("CREATE_ERROR:AMBIGUOUS_ORG:You belong to multiple organizations");

    cliFetchMock
      .mockResolvedValueOnce(
        response(true, 200, {
          memberships: [{ organizationId: "org-1", organizationName: "Org One", role: "admin" }],
        }),
      )
      .mockResolvedValueOnce(response(false, 400, { error: "bad name" }));
    await expect(
      program.parseAsync(["create", "bad", "--type", "agent", "--client-id", "client-1"], { from: "user" }),
    ).rejects.toThrow("CREATE_ERROR:CREATE_ERROR:bad name");
  });
});
