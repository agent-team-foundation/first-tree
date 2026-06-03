import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type AgentRuntimeConfig,
  type AgentRuntimeConfigPatch,
  agentRuntimeConfigPayloadSchema,
} from "@first-tree/shared";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bootstrapMocks = vi.hoisted(() => ({
  ensureFreshAdminToken: vi.fn(),
  resolveServerUrl: vi.fn(),
}));

const fetcherMocks = vi.hoisted(() => ({
  adminFetch: vi.fn(),
  getAgentResources: vi.fn(),
  getCurrent: vi.fn(),
  patchAgentResources: vi.fn(),
  patchConfig: vi.fn(),
  printConfig: vi.fn(),
  resolveAgentRecord: vi.fn(),
}));

const outputMocks = vi.hoisted(() => ({
  fail: vi.fn((code: string, message: string, exitCode = 1) => {
    throw Object.assign(new Error(message), { code, exitCode });
  }),
  success: vi.fn(),
}));

vi.mock("../core/bootstrap.js", () => bootstrapMocks);
vi.mock("../commands/agent/config/_shared/fetchers.js", () => fetcherMocks);
vi.mock("../cli/output.js", () => outputMocks);

const NOW = "2026-06-01T00:00:00.000Z";
let tempDir = "";

function config(overrides: Partial<AgentRuntimeConfig> = {}): AgentRuntimeConfig {
  return {
    agentId: overrides.agentId ?? "agent-1",
    version: overrides.version ?? 1,
    payload: overrides.payload ?? {
      kind: "claude-code",
      prompt: { append: "base prompt" },
      model: "sonnet",
      reasoningEffort: "medium",
      mcpServers: [{ name: "existing", transport: "stdio", command: "node", args: ["server.js"] }],
      env: [{ key: "KEEP", value: "1", sensitive: false }],
      gitRepos: [{ url: "https://github.com/acme/old.git", localPath: "old" }],
      resourceSkills: [],
    },
    updatedAt: overrides.updatedAt ?? NOW,
    updatedBy: overrides.updatedBy ?? "member-1",
  };
}

async function runConfig(args: string[]): Promise<void> {
  const { registerAgentConfigCommands } = await import("../commands/agent/config/index.js");
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  const agent = program.command("agent");
  registerAgentConfigCommands(agent);
  await program.parseAsync(["node", "test", "agent", "config", ...args]);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ft-cli-agent-config-"));
  vi.clearAllMocks();
  bootstrapMocks.ensureFreshAdminToken.mockResolvedValue("admin-token");
  bootstrapMocks.resolveServerUrl.mockReturnValue("https://hub.example");
  fetcherMocks.resolveAgentRecord.mockResolvedValue({ uuid: "agent-uuid", name: "kael" });
  fetcherMocks.getCurrent.mockResolvedValue(config());
  fetcherMocks.getAgentResources.mockResolvedValue({
    version: 1,
    bindings: [],
    effective: { version: 1, repos: [], prompts: [], skills: [], mcp: [], unavailable: [] },
    availableTeamResources: [],
  });
  fetcherMocks.patchAgentResources.mockResolvedValue({
    version: 2,
    bindings: [],
    effective: { version: 2, repos: [], prompts: [], skills: [], mcp: [], unavailable: [] },
    availableTeamResources: [],
  });
  fetcherMocks.patchConfig.mockImplementation(
    async (
      _serverUrl: string,
      _adminToken: string,
      _uuid: string,
      _version: number,
      patch: AgentRuntimeConfigPatch,
    ) => {
      const current = config();
      return config({
        version: current.version + 1,
        payload: agentRuntimeConfigPayloadSchema.parse({
          ...current.payload,
          ...patch,
        }),
      });
    },
  );
});

afterEach(() => {
  rmSync(tempDir, { force: true, recursive: true });
});

describe("agent config command behavior", () => {
  it("rejects legacy per-agent MCP writes", async () => {
    await expect(
      runConfig(["add-mcp", "kael", "--name", "tools", "--transport", "stdio", "--command", "uvx", "--args", "a", "b"]),
    ).rejects.toMatchObject({
      code: "LEGACY_MCP_CONFIG_DISABLED",
      exitCode: 2,
    });
    expect(outputMocks.fail).toHaveBeenCalledWith(
      "LEGACY_MCP_CONFIG_DISABLED",
      "Legacy per-agent MCP config writes are disabled. MCP configuration will be managed by Team MCP Resources.",
      2,
    );
    expect(fetcherMocks.patchConfig).not.toHaveBeenCalled();
  });

  it("updates git repos, env vars, model, reasoning effort, and prompt append", async () => {
    await runConfig(["add-repo", "kael", "https://github.com/acme/web.git", "--ref", "main", "--path", "web"]);
    expect(fetcherMocks.patchAgentResources).toHaveBeenLastCalledWith(
      "https://hub.example",
      "admin-token",
      "agent-uuid",
      {
        expectedVersion: 1,
        bindings: [
          {
            type: "repo",
            mode: "include",
            agentExtraRepo: { url: "https://github.com/acme/web.git" },
            repoRef: "main",
            repoLocalPath: "web",
            order: 1,
          },
        ],
      },
    );

    await runConfig(["set-env", "kael", "OPENAI_API_KEY=secret", "--sensitive"]);
    expect(fetcherMocks.patchConfig).toHaveBeenLastCalledWith("https://hub.example", "admin-token", "agent-uuid", 1, {
      env: [
        { key: "KEEP", value: "1", sensitive: false },
        { key: "OPENAI_API_KEY", value: "secret", sensitive: true },
      ],
    });

    await expect(runConfig(["set-env", "kael", "BROKEN"])).rejects.toMatchObject({ code: "BAD_KV", exitCode: 2 });

    await runConfig(["set-model", "kael", "opus"]);
    expect(fetcherMocks.patchConfig).toHaveBeenLastCalledWith("https://hub.example", "admin-token", "agent-uuid", 1, {
      model: "opus",
    });
    expect(outputMocks.success).toHaveBeenLastCalledWith({ agentId: "agent-1", version: 2, model: "opus" });

    await runConfig(["set-reasoning-effort", "kael", "high"]);
    expect(fetcherMocks.patchConfig).toHaveBeenLastCalledWith("https://hub.example", "admin-token", "agent-uuid", 1, {
      reasoningEffort: "high",
    });
    expect(outputMocks.success).toHaveBeenLastCalledWith({
      agentId: "agent-1",
      version: 2,
      reasoningEffort: "high",
    });

    const promptFile = join(tempDir, "prompt.md");
    writeFileSync(promptFile, "Prefer small diffs.");
    await runConfig(["append-prompt", "kael", "--file", promptFile]);
    expect(fetcherMocks.patchAgentResources).toHaveBeenLastCalledWith(
      "https://hub.example",
      "admin-token",
      "agent-uuid",
      {
        expectedVersion: 1,
        bindings: [
          {
            type: "prompt",
            mode: "include",
            resourceId: null,
            inlinePromptBody: "Prefer small diffs.",
            order: 1,
          },
        ],
      },
    );
    expect(outputMocks.success).toHaveBeenLastCalledWith({ agentId: "agent-uuid", version: 2, append_length: 19 });
  });

  it("replaces the existing inline append prompt binding", async () => {
    fetcherMocks.getAgentResources.mockResolvedValueOnce({
      version: 3,
      bindings: [
        {
          id: "old-prompt",
          type: "prompt",
          mode: "include",
          resourceId: null,
          replacesResourceId: null,
          inlinePromptBody: "Old prompt.",
          order: 2,
        },
        {
          id: "keep-repo",
          type: "repo",
          mode: "include",
          resourceId: "team-repo",
          order: 1,
        },
      ],
      effective: { version: 3, repos: [], prompts: [], skills: [], mcp: [], unavailable: [] },
      availableTeamResources: [],
    });

    const promptFile = join(tempDir, "prompt-replacement.md");
    writeFileSync(promptFile, "New prompt.");
    await runConfig(["append-prompt", "kael", "--file", promptFile]);

    expect(fetcherMocks.patchAgentResources).toHaveBeenLastCalledWith(
      "https://hub.example",
      "admin-token",
      "agent-uuid",
      {
        expectedVersion: 3,
        bindings: [
          {
            id: "keep-repo",
            type: "repo",
            mode: "include",
            resourceId: "team-repo",
            order: 1,
          },
          {
            type: "prompt",
            mode: "include",
            resourceId: null,
            inlinePromptBody: "New prompt.",
            order: 2,
          },
        ],
      },
    );
  });

  it("replaces an existing agent-scoped repo binding by canonical url", async () => {
    fetcherMocks.getAgentResources.mockResolvedValueOnce({
      version: 4,
      bindings: [
        {
          id: "old-agent-repo",
          type: "repo",
          mode: "include",
          resourceId: "agent-repo-resource",
          repoRef: "old",
          repoLocalPath: "web",
          order: 3,
        },
      ],
      effective: {
        version: 4,
        repos: [
          {
            id: "binding:old-agent-repo:enabled",
            bindingId: "old-agent-repo",
            resourceId: "agent-repo-resource",
            replacesResourceId: null,
            type: "repo",
            name: "web",
            scope: "agent",
            source: "agent_extra",
            mode: "enabled",
            defaultEnabled: null,
            payload: { url: "git@github.com:Acme/Web.git" },
            repo: { url: "git@github.com:Acme/Web.git", localPath: "web" },
            promptBody: null,
            unavailableReason: null,
            order: 3,
          },
        ],
        prompts: [],
        skills: [],
        mcp: [],
        unavailable: [],
      },
      availableTeamResources: [],
    });

    await runConfig(["add-repo", "kael", "https://github.com/acme/web.git", "--ref", "main", "--path", "web"]);

    expect(fetcherMocks.patchAgentResources).toHaveBeenLastCalledWith(
      "https://hub.example",
      "admin-token",
      "agent-uuid",
      {
        expectedVersion: 4,
        bindings: [
          {
            type: "repo",
            mode: "include",
            agentExtraRepo: { url: "https://github.com/acme/web.git" },
            repoRef: "main",
            repoLocalPath: "web",
            order: 3,
          },
        ],
      },
    );
  });

  it("shows config and prints dry-run diffs", async () => {
    await runConfig(["show", "kael"]);
    expect(fetcherMocks.printConfig).toHaveBeenCalledWith(config());

    const patchFile = join(tempDir, "patch.json");
    writeFileSync(patchFile, JSON.stringify({ model: "haiku", env: [] }));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    fetcherMocks.adminFetch.mockResolvedValueOnce({
      current: config(),
      next: { ...config().payload, model: "haiku" },
      diff: [
        { op: "replace", path: "/model", before: "sonnet", after: "haiku" },
        { op: "replace", path: "/env", before: [{ key: "KEEP", value: "1", sensitive: false }], after: [] },
      ],
    });

    await runConfig(["dry-run", "kael", "--file", patchFile]);

    expect(fetcherMocks.adminFetch).toHaveBeenCalledWith(
      "https://hub.example/api/v1/agents/agent-uuid/config/dry-run",
      {
        method: "POST",
        adminToken: "admin-token",
        body: JSON.stringify({ payload: { model: "haiku", env: [] } }),
      },
    );
    expect(stdout.mock.calls.map((call) => String(call[0])).join("")).toContain("Diff (2 changes):");
    stdout.mockRestore();
  });
});
