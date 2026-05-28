import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cliFetchMock = vi.fn();
const failMock = vi.fn();
const resolveAgentMock = vi.fn();

function response(ok: boolean, status: number, body: unknown, text = "") {
  return {
    ok,
    status,
    statusText: `status-${status}`,
    json: async () => body,
    text: async () => text,
  };
}

async function loadFetchers() {
  vi.doMock("../cli/output.js", () => ({
    fail: failMock,
  }));
  vi.doMock("../commands/_shared/resolve-agent.js", () => ({
    resolveAgent: resolveAgentMock,
  }));
  vi.doMock("../core/cli-fetch.js", () => ({
    cliFetch: cliFetchMock,
  }));
  return import("../commands/agent/config/_shared/fetchers.js");
}

describe("agent config fetchers", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    failMock.mockImplementation((code: string, message: string, exitCode?: number) => {
      throw new Error(`${code}:${message}:${exitCode ?? ""}`);
    });
    resolveAgentMock.mockResolvedValue({ id: "agent-1", name: "atlas" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adds auth and JSON headers for admin fetches and maps HTTP failures through fail", async () => {
    const { adminFetch } = await loadFetchers();
    cliFetchMock.mockResolvedValueOnce(response(true, 200, { ok: true }));

    await expect(
      adminFetch("https://hub.example.test/api", {
        method: "PATCH",
        adminToken: "admin-token",
        body: JSON.stringify({ ok: true }),
        headers: { "X-Test": "yes" },
      }),
    ).resolves.toEqual({ ok: true });

    expect(cliFetchMock).toHaveBeenCalledWith(
      "https://hub.example.test/api",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ ok: true }),
        headers: {
          Authorization: "Bearer admin-token",
          "Content-Type": "application/json",
          "X-Test": "yes",
        },
      }),
    );

    cliFetchMock.mockResolvedValueOnce(response(false, 401, {}, "expired"));
    await expect(
      adminFetch("https://hub.example.test/api", { method: "GET", adminToken: "admin-token" }),
    ).rejects.toThrow("HTTP_401:expired:3");

    cliFetchMock.mockResolvedValueOnce(response(false, 500, {}, ""));
    await expect(
      adminFetch("https://hub.example.test/api", { method: "GET", adminToken: "admin-token" }),
    ).rejects.toThrow("HTTP_500:status-500:1");
  });

  it("wraps resolve, current-config, and patch-config API calls", async () => {
    const { getCurrent, patchConfig, resolveAgentRecord } = await loadFetchers();
    cliFetchMock
      .mockResolvedValueOnce(response(true, 200, { agentId: "agent-1", version: 1 }))
      .mockResolvedValueOnce(response(true, 200, { agentId: "agent-1", version: 2 }));

    await expect(resolveAgentRecord("https://hub.example.test", "admin-token", "atlas")).resolves.toEqual({
      id: "agent-1",
      name: "atlas",
    });
    expect(resolveAgentMock).toHaveBeenCalledWith("https://hub.example.test", "admin-token", "atlas");

    await expect(getCurrent("https://hub.example.test", "admin-token", "agent-1")).resolves.toMatchObject({
      version: 1,
    });
    expect(cliFetchMock).toHaveBeenCalledWith(
      "https://hub.example.test/api/v1/agents/agent-1/config",
      expect.objectContaining({ method: "GET" }),
    );

    await expect(
      patchConfig("https://hub.example.test", "admin-token", "agent-1", 1, { model: "gpt-test" }),
    ).resolves.toMatchObject({ version: 2 });
    expect(cliFetchMock).toHaveBeenCalledWith(
      "https://hub.example.test/api/v1/agents/agent-1/config",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ expectedVersion: 1, payload: { model: "gpt-test" } }),
      }),
    );
  });

  it("prints config summaries with model, prompt, MCP, env, and Git rows", async () => {
    const { printConfig } = await loadFetchers();
    const writeMock = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    printConfig({
      agentId: "agent-1",
      version: 7,
      updatedAt: "2026-05-28T00:00:00.000Z",
      updatedBy: "member-1",
      payload: {
        kind: "codex",
        model: "gpt-test",
        prompt: { append: "Line one\nLine two" },
        mcpServers: [{ name: "github", transport: "stdio", command: "npx" }],
        env: [{ key: "GITHUB_TOKEN", value: "***", sensitive: true }],
        gitRepos: [{ url: "https://github.com/agent-team-foundation/first-tree", ref: "main", localPath: "repo" }],
      },
    });

    const printed = writeMock.mock.calls.map((call) => String(call[0])).join("");
    expect(printed).toContain("Agent: agent-1");
    expect(printed).toContain("Model:    gpt-test");
    expect(printed).toContain("> Line one");
    expect(printed).toContain("github [stdio]");
    expect(printed).toContain("GITHUB_TOKEN=*** (sensitive)");
    expect(printed).toContain("https://github.com/agent-team-foundation/first-tree@main");
    expect(printed).toContain("\u2192 repo");
  });
});
