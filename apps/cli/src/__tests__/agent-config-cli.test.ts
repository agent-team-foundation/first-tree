import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerAgentConfigCommands } from "../commands/agent/config/index.js";

describe("agent config CLI registration (Step 8)", () => {
  it("registers all 7 subcommands under `config`", () => {
    const root = new Command();
    const agent = root.command("agent");
    registerAgentConfigCommands(agent);

    const configCmd = agent.commands.find((c) => c.name() === "config");
    expect(configCmd).toBeDefined();
    const subs = configCmd?.commands.map((c) => c.name()).sort();
    expect(subs).toEqual(["add-mcp", "add-repo", "append-prompt", "dry-run", "set-env", "set-model", "show"]);
  });

  it("set-env requires KEY=VALUE", () => {
    const root = new Command();
    const agent = root.command("agent");
    registerAgentConfigCommands(agent);
    const setEnv = agent.commands.find((c) => c.name() === "config")?.commands.find((c) => c.name() === "set-env");
    expect(setEnv?.options.some((o) => o.long === "--sensitive")).toBe(true);
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
});
