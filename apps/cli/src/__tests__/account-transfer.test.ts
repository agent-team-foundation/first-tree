import { beforeEach, describe, expect, it, vi } from "vitest";

const cliFetchMock = vi.fn();
const confirmMock = vi.fn();
const ensureFreshAccessTokenMock = vi.fn();
const failMock = vi.fn();
const findStaleAliasesMock = vi.fn();
const listMyAgentsMock = vi.fn();
const printLineMock = vi.fn();
const removeLocalAgentMock = vi.fn();

class FakeSdk {
  listMyAgents = listMyAgentsMock;
}

function response(ok: boolean, status: number, body: unknown) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

async function loadHelpers() {
  vi.doMock("@first-tree/client", () => ({
    FirstTreeHubSDK: FakeSdk,
  }));
  vi.doMock("@inquirer/prompts", () => ({
    confirm: confirmMock,
  }));
  vi.doMock("../cli/output.js", () => ({
    fail: failMock,
  }));
  vi.doMock("../core/agent-prune.js", () => ({
    findStaleAliases: findStaleAliasesMock,
    formatStaleReason: (reason: string) => `stale:${reason}`,
    removeLocalAgent: removeLocalAgentMock,
  }));
  vi.doMock("../core/bootstrap.js", () => ({
    ensureFreshAccessToken: ensureFreshAccessTokenMock,
  }));
  vi.doMock("../core/cli-fetch.js", () => ({
    cliFetch: cliFetchMock,
  }));
  vi.doMock("../core/output.js", () => ({
    print: { line: printLineMock },
  }));
  vi.doMock("../core/version.js", () => ({
    CLI_USER_AGENT: "first-tree-test",
  }));

  return import("../commands/_shared/account-transfer.js");
}

describe("account transfer helpers", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    ensureFreshAccessTokenMock.mockResolvedValue("access-token");
    failMock.mockImplementation((code: string, message: string) => {
      throw new Error(`${code}:${message}`);
    });
    findStaleAliasesMock.mockResolvedValue([]);
    listMyAgentsMock.mockResolvedValue([]);
    removeLocalAgentMock.mockImplementation(() => {});
  });

  it("claims a client with the current JWT and surfaces server failures", async () => {
    const { postClaim } = await loadHelpers();
    cliFetchMock.mockResolvedValueOnce(
      response(true, 200, { clientId: "client-1", previousUserId: "user-old", unpinnedAgentCount: 2 }),
    );

    await expect(postClaim("https://hub.example.test", "client/one")).resolves.toEqual({
      clientId: "client-1",
      previousUserId: "user-old",
      unpinnedAgentCount: 2,
    });

    expect(cliFetchMock).toHaveBeenCalledWith(
      "https://hub.example.test/api/v1/clients/client%2Fone/claim",
      expect.objectContaining({
        body: "{}",
        headers: {
          Authorization: "Bearer access-token",
          "Content-Type": "application/json",
        },
        method: "POST",
      }),
    );

    cliFetchMock.mockResolvedValueOnce(response(false, 409, "already claimed"));
    await expect(postClaim("https://hub.example.test", "client-1")).rejects.toThrow(
      "CLAIM_ERROR:Server returned 409: already claimed",
    );
  });

  it("prints the no-op stale-alias cleanup path", async () => {
    const { cleanupStaleAliasesAfterClaim } = await loadHelpers();

    await cleanupStaleAliasesAfterClaim({ serverUrl: "https://hub.example.test", clientId: "client-1" });

    expect(findStaleAliasesMock).toHaveBeenCalledWith({
      clientId: "client-1",
      listPinnedAgents: expect.any(Function),
    });
    expect(printLineMock.mock.calls.flat().join("")).toContain("No stale local aliases");
  });

  it("removes approved stale aliases and reports per-alias failures", async () => {
    const { cleanupStaleAliasesAfterClaim } = await loadHelpers();
    findStaleAliasesMock.mockResolvedValueOnce([
      { name: "old-a", agentId: "agent-a", reason: "unpinned" },
      { name: "old-b", agentId: null, reason: "missing" },
    ]);
    removeLocalAgentMock.mockImplementation((name: string) => {
      if (name === "old-b") throw new Error("disk read-only");
    });

    await cleanupStaleAliasesAfterClaim({
      serverUrl: "https://hub.example.test",
      clientId: "client-1",
      nonInteractive: true,
    });

    const printed = printLineMock.mock.calls.flat().join("");
    expect(removeLocalAgentMock).toHaveBeenCalledWith("old-a");
    expect(removeLocalAgentMock).toHaveBeenCalledWith("old-b");
    expect(printed).toContain("2 local aliases");
    expect(printed).toContain("stale:unpinned");
    expect(printed).toContain("1 pruned, 1 failed");
  });

  it("honors declined cleanup prompts and catches stale-check failures", async () => {
    const { cleanupStaleAliasesAfterClaim } = await loadHelpers();
    findStaleAliasesMock.mockResolvedValueOnce([{ name: "old-a", agentId: "agent-a", reason: "unpinned" }]);
    confirmMock.mockResolvedValueOnce(false);

    await cleanupStaleAliasesAfterClaim({ serverUrl: "https://hub.example.test", clientId: "client-1" });

    expect(removeLocalAgentMock).not.toHaveBeenCalled();
    expect(printLineMock.mock.calls.flat().join("")).toContain("Skipped.");

    printLineMock.mockClear();
    findStaleAliasesMock.mockRejectedValueOnce(new Error("network down"));
    await cleanupStaleAliasesAfterClaim({ serverUrl: "https://hub.example.test", clientId: "client-1" });

    const printed = printLineMock.mock.calls.flat().join("");
    expect(printed).toContain("Could not check for stale aliases: network down");
    expect(printed).toContain("Run `first-tree agent prune` after reconnecting.");
  });
});
