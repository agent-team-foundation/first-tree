import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { createCommandContext } from "../src/commands/context.js";
import { registerSubcommands } from "../src/commands/groups.js";
import type { SubcommandModule } from "../src/commands/types.js";

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
