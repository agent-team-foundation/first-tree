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
  getCurrent: vi.fn(),
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
  it("adds stdio, http, and sse MCP servers and validates required transport options", async () => {
    await runConfig([
      "add-mcp",
      "kael",
      "--name",
      "tools",
      "--transport",
      "stdio",
      "--command",
      "uvx",
      "--args",
      "a",
      "b",
    ]);
    expect(fetcherMocks.patchConfig).toHaveBeenLastCalledWith("https://hub.example", "admin-token", "agent-uuid", 1, {
      mcpServers: [
        { name: "existing", transport: "stdio", command: "node", args: ["server.js"] },
        { name: "tools", transport: "stdio", command: "uvx", args: ["a", "b"] },
      ],
    });
    expect(outputMocks.success).toHaveBeenLastCalledWith({ agentId: "agent-1", version: 2, mcpServer: "tools" });

    await runConfig(["add-mcp", "kael", "--name", "api", "--transport", "http", "--url", "https://mcp.example"]);
    expect(fetcherMocks.patchConfig).toHaveBeenLastCalledWith("https://hub.example", "admin-token", "agent-uuid", 1, {
      mcpServers: [
        { name: "existing", transport: "stdio", command: "node", args: ["server.js"] },
        { name: "api", transport: "http", url: "https://mcp.example" },
      ],
    });

    await runConfig(["add-mcp", "kael", "--name", "events", "--transport", "sse", "--url", "https://mcp.example/sse"]);
    expect(fetcherMocks.patchConfig).toHaveBeenLastCalledWith("https://hub.example", "admin-token", "agent-uuid", 1, {
      mcpServers: [
        { name: "existing", transport: "stdio", command: "node", args: ["server.js"] },
        { name: "events", transport: "sse", url: "https://mcp.example/sse" },
      ],
    });

    await expect(runConfig(["add-mcp", "kael", "--name", "bad", "--transport", "stdio"])).rejects.toMatchObject({
      code: "MISSING_COMMAND",
      exitCode: 2,
    });
    await expect(runConfig(["add-mcp", "kael", "--name", "bad", "--transport", "http"])).rejects.toMatchObject({
      code: "MISSING_URL",
      exitCode: 2,
    });
    await expect(runConfig(["add-mcp", "kael", "--name", "bad", "--transport", "pipe"])).rejects.toMatchObject({
      code: "BAD_TRANSPORT",
      exitCode: 2,
    });
  });

  it("updates git repos, env vars, model, reasoning effort, and prompt append", async () => {
    await runConfig(["add-repo", "kael", "https://github.com/acme/web.git", "--ref", "main", "--path", "web"]);
    expect(fetcherMocks.patchConfig).toHaveBeenLastCalledWith("https://hub.example", "admin-token", "agent-uuid", 1, {
      gitRepos: [
        { url: "https://github.com/acme/old.git", localPath: "old" },
        { url: "https://github.com/acme/web.git", ref: "main", localPath: "web" },
      ],
    });

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
    expect(fetcherMocks.patchConfig).toHaveBeenLastCalledWith("https://hub.example", "admin-token", "agent-uuid", 1, {
      prompt: { append: "Prefer small diffs." },
    });
    expect(outputMocks.success).toHaveBeenLastCalledWith({ agentId: "agent-1", version: 2, append_length: 19 });
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
