import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerAgentConfigCommands } from "../commands/agent/config/index.js";

const failMock = vi.hoisted(() =>
  vi.fn((code: string, message: string, exitCode = 1) => {
    throw Object.assign(new Error(message), { code, exitCode });
  }),
);

vi.mock("../cli/output.js", () => ({
  fail: failMock,
  success: vi.fn(),
}));

describe("agent config CLI registration (Step 8)", () => {
  it("registers all 9 subcommands under `config`", () => {
    const root = new Command();
    const agent = root.command("agent");
    registerAgentConfigCommands(agent);

    const configCmd = agent.commands.find((c) => c.name() === "config");
    expect(configCmd).toBeDefined();
    const subs = configCmd?.commands.map((c) => c.name()).sort();
    expect(subs).toEqual([
      "add-mcp",
      "add-repo",
      "append-prompt",
      "dry-run",
      "get-capabilities",
      "prompt",
      "set-capabilities",
      "set-env",
      "set-model",
      "set-reasoning-effort",
      "show",
    ]);
  });

  it("registers `prompt show` (--raw) and `prompt set` (-f/--force); append-prompt stays as deprecated alias", () => {
    const root = new Command();
    const agent = root.command("agent");
    registerAgentConfigCommands(agent);
    const configCmd = agent.commands.find((c) => c.name() === "config");
    const promptCmd = configCmd?.commands.find((c) => c.name() === "prompt");
    expect(promptCmd).toBeDefined();

    const show = promptCmd?.commands.find((c) => c.name() === "show");
    expect(show?.options.some((o) => o.long === "--raw")).toBe(true);

    const set = promptCmd?.commands.find((c) => c.name() === "set");
    expect(set?.options.some((o) => o.long === "--file")).toBe(true);
    expect(set?.options.some((o) => o.long === "--force")).toBe(true);

    const appendPrompt = configCmd?.commands.find((c) => c.name() === "append-prompt");
    expect(appendPrompt?.description()).toContain("deprecated");
    expect(appendPrompt?.options.some((o) => o.long === "--force")).toBe(true);
  });

  it("set-env requires KEY=VALUE", () => {
    const root = new Command();
    const agent = root.command("agent");
    registerAgentConfigCommands(agent);
    const setEnv = agent.commands.find((c) => c.name() === "config")?.commands.find((c) => c.name() === "set-env");
    expect(setEnv?.options.some((o) => o.long === "--sensitive")).toBe(true);
  });

  it("documents Codex max and ultra reasoning effort", () => {
    const root = new Command();
    const agent = root.command("agent");
    registerAgentConfigCommands(agent);
    const reasoningEffort = agent.commands
      .find((c) => c.name() === "config")
      ?.commands.find((c) => c.name() === "set-reasoning-effort");

    expect(reasoningEffort?.description()).toContain("xhigh | max | ultra");
    expect(reasoningEffort?.description()).toContain("model-dependent");
  });

  it("add-mcp accepts --transport / --command / --url / --args", () => {
    const root = new Command();
    const agent = root.command("agent");
    registerAgentConfigCommands(agent);
    const addMcp = agent.commands.find((c) => c.name() === "config")?.commands.find((c) => c.name() === "add-mcp");
    const opts = addMcp?.options.map((o) => o.long).sort() ?? [];
    expect(opts).toContain("--name");
    expect(opts).toContain("--transport");
    expect(opts).toContain("--command");
    expect(opts).toContain("--url");
    expect(opts).toContain("--args");
  });

  it("add-mcp is registered but exits before writing legacy MCP config", async () => {
    const root = new Command();
    root.exitOverride();
    const agent = root.command("agent");
    registerAgentConfigCommands(agent);

    await expect(
      root.parseAsync(["node", "test", "agent", "config", "add-mcp", "nova", "--name", "docs", "--transport", "http"]),
    ).rejects.toMatchObject({ code: "LEGACY_MCP_CONFIG_DISABLED", exitCode: 2 });
    expect(failMock).toHaveBeenCalledWith(
      "LEGACY_MCP_CONFIG_DISABLED",
      expect.stringContaining("Team MCP Resources"),
      2,
    );
  });
});
