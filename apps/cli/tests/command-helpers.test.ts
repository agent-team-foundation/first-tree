import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCommandContext } from "../src/commands/context.js";
import { registerSubcommands } from "../src/commands/groups.js";
import { runStatusCommand } from "../src/commands/tree/status.js";
import type { CommandContext, SubcommandModule } from "../src/commands/types.js";

const tempDirs: string[] = [];
const originalCwd = process.cwd();

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "first-tree-helpers-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();

    if (dir !== undefined) {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

describe("registerSubcommands", () => {
  it("applies alias and summary when they are provided", () => {
    const program = new Command();
    const group = program.command("example");

    const subcommands: SubcommandModule[] = [
      {
        name: "status",
        alias: "stat",
        summary: "Short summary",
        description: "Long description",
        action: () => {},
      },
    ];

    registerSubcommands(group, subcommands);

    const registered = group.commands[0];
    expect(registered?.name()).toBe("status");
    expect(registered?.aliases()).toEqual(["stat"]);
    expect(registered?.summary()).toBe("Short summary");
    expect(registered?.description()).toBe("Long description");
  });

  it("leaves alias and summary empty when they are omitted", () => {
    const program = new Command();
    const group = program.command("example");

    registerSubcommands(group, [
      {
        name: "inspect",
        alias: "",
        summary: "",
        description: "Inspect",
        action: () => {},
      },
    ]);

    const registered = group.commands[0];
    expect(registered?.aliases()).toEqual([]);
    expect(registered?.summary()).toBe("");
  });
});

describe("createCommandContext", () => {
  it("returns default options when no raw argv is available", () => {
    const program = new Command();
    program.name("first-tree").option("--json").option("--debug").option("--quiet");
    const command = program.command("probe");

    const context = createCommandContext(command);

    expect(context.options).toEqual({
      json: false,
      debug: false,
      quiet: false,
    });
  });
});

describe("runStatusCommand", () => {
  const baseContext: CommandContext = {
    command: new Command("status"),
    options: {
      debug: false,
      json: false,
      quiet: false,
    },
  };

  it("exits 1 with W1 onboarding guidance when no workspace.json is found", () => {
    const root = makeTempDir();
    writeFileSync(join(root, ".git"), "gitdir: /tmp/mock\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    process.chdir(root);

    runStatusCommand(baseContext);

    expect(log).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const stderr = err.mock.calls.map((call) => String(call[0])).join("\n");
    expect(stderr).toContain("No First Tree workspace found");
    expect(stderr).toContain("tree init --tree-path");
    expect(stderr).toContain("migrate-to-w1");

    process.exitCode = undefined;
  });
});
