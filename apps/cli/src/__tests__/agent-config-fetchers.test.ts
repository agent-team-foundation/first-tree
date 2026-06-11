import type { AgentRuntimeConfig } from "@first-tree/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
const failMock = vi.hoisted(() =>
  vi.fn((code: string, message: string, exitCode = 1) => {
    throw Object.assign(new Error(message), { code, exitCode });
  }),
);
const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

vi.mock("../core/cli-fetch.js", () => ({
  cliFetch: fetchMock,
}));

vi.mock("../cli/output.js", () => ({
  fail: failMock,
}));

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Nope",
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as Response;
}

function config(overrides: Partial<AgentRuntimeConfig> = {}): AgentRuntimeConfig {
  return {
    agentId: overrides.agentId ?? "agent-1",
    version: overrides.version ?? 7,
    payload: overrides.payload ?? {
      kind: "claude-code",
      prompt: { append: "Use short answers.\nExplain risks." },
      model: "sonnet",
      reasoningEffort: "high",
      mcpServers: [
        { name: "filesystem", transport: "stdio", command: "npx", args: ["-y", "server"] },
        { name: "docs", transport: "http", url: "https://docs.example/mcp", headers: { Authorization: "Bearer test" } },
      ],
      env: [
        { key: "FIRST_TREE_ENV", value: "test", sensitive: false },
        { key: "OPENAI_API_KEY", value: "***", sensitive: true },
      ],
      gitRepos: [{ url: "https://github.com/acme/web.git", localPath: "web", ref: "main" }],
      resourceSkills: [],
    },
    updatedAt: overrides.updatedAt ?? "2026-05-28T12:00:00.000Z",
    updatedBy: overrides.updatedBy ?? "member-1",
  };
}

function output(): string {
  return stdoutSpy.mock.calls.map((call) => String(call[0])).join("");
}

describe("agent config fetch helpers", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    failMock.mockClear();
    stdoutSpy.mockClear();
  });

  it("adds auth and content headers, then parses JSON", async () => {
    const { adminFetch } = await import("../commands/agent/config/_shared/fetchers.js");
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await expect(
      adminFetch<{ ok: boolean }>("https://first-tree.example/api/v1/agents/agent-1/config", {
        method: "PATCH",
        adminToken: "admin-token",
        headers: { "X-Test": "1" },
        body: JSON.stringify({ expectedVersion: 1, payload: {} }),
      }),
    ).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://first-tree.example/api/v1/agents/agent-1/config",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ expectedVersion: 1, payload: {} }),
        headers: {
          Authorization: "Bearer admin-token",
          "Content-Type": "application/json",
          "X-Test": "1",
        },
      }),
    );
  });

  it("maps HTTP errors and wraps get/patch URLs", async () => {
    const { getCurrent, patchConfig } = await import("../commands/agent/config/_shared/fetchers.js");
    fetchMock.mockResolvedValueOnce(jsonResponse("unauthorized", false, 401));

    await expect(getCurrent("https://first-tree.example", "admin-token", "agent-1")).rejects.toMatchObject({
      code: "HTTP_401",
      exitCode: 3,
    });

    fetchMock.mockResolvedValueOnce(jsonResponse(config({ version: 8 })));
    await expect(
      patchConfig("https://first-tree.example", "admin-token", "agent-1", 7, { model: "opus" }),
    ).resolves.toMatchObject({ version: 8 });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://first-tree.example/api/v1/agents/agent-1/config",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ expectedVersion: 7, payload: { model: "opus" } }),
      }),
    );
  });

  it("prints a readable runtime config summary", async () => {
    const { printConfig } = await import("../commands/agent/config/_shared/fetchers.js");

    printConfig(config());

    expect(output()).toContain("Agent: agent-1");
    expect(output()).toContain("Version: 7");
    expect(output()).toContain("Model:    sonnet");
    expect(output()).toContain("Reasoning effort: high");
    expect(output()).toContain("> Use short answers.");
    expect(output()).toContain("filesystem [stdio]");
    expect(output()).toContain("OPENAI_API_KEY=*** (sensitive)");
    expect(output()).toContain("https://github.com/acme/web.git@main");
  });

  it("prints the effective prompt stack with provenance when prompt.sections is present", async () => {
    const { printConfig } = await import("../commands/agent/config/_shared/fetchers.js");
    const base = config();

    printConfig(
      config({
        payload: {
          ...base.payload,
          prompt: {
            append: "merged legacy blob",
            sections: [
              { scope: "team", name: "Review rules", body: "Always review twice." },
              { scope: "agent", name: "", body: "Prefer terse replies.", editable: true },
              // Inline replacement of a team prompt: agent scope, but NOT the
              // fragment `prompt set` owns — labelled as a binding-managed override.
              { scope: "agent", name: "Tone guide", body: "Agent-specific tone override.", editable: false },
            ],
          },
        },
      }),
    );

    expect(output()).toContain("Effective prompt stack (3 section(s)");
    expect(output()).toContain("[team] Review rules (");
    expect(output()).toContain("[agent] per-agent fragment (");
    expect(output()).toContain("[agent] Tone guide (override; managed via resource bindings) (");
    // Pointer to the round-trippable editing flow for the only editable source.
    expect(output()).toContain("`agent config prompt show --raw` / `prompt set`");
    // The legacy single-blob rendering must not also appear.
    expect(output()).not.toContain("Prompt append:");
  });
});
