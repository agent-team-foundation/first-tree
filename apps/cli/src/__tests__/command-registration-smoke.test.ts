import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerAgentCommands } from "../commands/agent/index.js";
import { registerAttentionCommands } from "../commands/attention/index.js";
import { registerChatCommands } from "../commands/chat/index.js";
import { registerConfigCommands } from "../commands/config/index.js";
import { registerDaemonCommands } from "../commands/daemon/index.js";
import { registerDoctorCommand } from "../commands/doctor.js";
import { registerGithubCommands } from "../commands/github/index.js";
import { registerLoginCommand } from "../commands/login.js";
import { registerLogoutCommand } from "../commands/logout.js";
import { registerOrgCommands } from "../commands/org/index.js";
import { registerStatusCommand } from "../commands/status.js";
import { registerTreeCommands } from "../commands/tree/index.js";
import { registerUpgradeCommand } from "../commands/upgrade.js";

function commandNames(command: Command): string[] {
  return command.commands.map((child) => child.name()).sort();
}

function subcommand(program: Command, name: string): Command {
  const found = program.commands.find((child) => child.name() === name);
  if (!found) throw new Error(`missing command ${name}`);
  return found;
}

describe("CLI command registration", () => {
  it("registers the top-level namespaces and their subcommands", () => {
    const program = new Command();
    program.exitOverride();

    registerLoginCommand(program);
    registerLogoutCommand(program);
    registerStatusCommand(program);
    registerDoctorCommand(program);
    registerUpgradeCommand(program);
    registerAgentCommands(program);
    registerAttentionCommands(program);
    registerChatCommands(program);
    registerOrgCommands(program);
    registerDaemonCommands(program);
    registerConfigCommands(program);
    registerTreeCommands(program);
    registerGithubCommands(program);

    expect(commandNames(program)).toEqual([
      "agent",
      "attention",
      "chat",
      "config",
      "daemon",
      "doctor",
      "github",
      "login",
      "logout",
      "org",
      "status",
      "tree",
      "upgrade",
    ]);

    expect(commandNames(subcommand(program, "agent"))).toEqual([
      "add",
      "bind",
      "claim",
      "config",
      "create",
      "debug",
      "list",
      "prune",
      "remove",
      "reset",
      "session",
      "status",
      "workspace",
    ]);
    expect(commandNames(subcommand(program, "chat"))).toEqual(["history", "invite", "list", "open", "send"]);
    expect(commandNames(subcommand(program, "daemon"))).toEqual([
      "doctor",
      "home-info",
      "refresh-unit",
      "restart",
      "start",
      "status",
      "stop",
    ]);
    expect(commandNames(subcommand(program, "tree"))).toContain("automation");
    expect(commandNames(subcommand(program, "tree"))).toContain("skill");
    expect(commandNames(subcommand(program, "github"))).toEqual(["scan"]);
  });
});
