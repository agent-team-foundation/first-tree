import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { createCommandContext, withCommandContext } from "../commands/context.js";

function rootCommand(rawArgs: string[]): Command {
  const command = new Command();
  command.option("--json");
  command.option("--debug");
  command.option("--quiet");
  command.command("agent").alias("a");
  Object.assign(command, { rawArgs });
  return command;
}

describe("createCommandContext", () => {
  it("uses the last debug/quiet flag from user argv after slicing node entrypoint args", () => {
    const command = rootCommand(["node", "first-tree", "--debug", "--quiet"]);
    command.setOptionValue("json", true);

    const context = createCommandContext(command);

    expect(context.options).toEqual({ json: true, debug: false, quiet: true });
  });

  it("stops global debug/quiet scanning at the option terminator", () => {
    const command = rootCommand(["node", "first-tree", "--debug", "--", "--quiet"]);

    expect(createCommandContext(command).options).toEqual({ json: false, debug: true, quiet: false });
  });

  it("keeps argv intact when it starts with an option or a known command token", () => {
    const optionFirst = rootCommand(["--quiet", "--debug"]);
    const commandFirst = rootCommand(["agent", "--debug"]);

    expect(createCommandContext(optionFirst).options).toMatchObject({ debug: true, quiet: false });
    expect(createCommandContext(commandFirst).options).toMatchObject({ debug: true, quiet: false });
  });

  it("honors aliases and compact short debug/quiet flags", () => {
    const command = rootCommand(["a", "-qd"]);

    expect(createCommandContext(command).options).toMatchObject({ debug: true, quiet: false });
  });

  it("walks from a child command to the root raw argv", () => {
    const root = rootCommand(["node", "first-tree", "-dq"]);
    const child = root.commands[0];
    if (!child) throw new Error("expected child command");

    expect(createCommandContext(child).options).toMatchObject({ debug: false, quiet: true });
  });

  it("wraps command actions with the computed context", async () => {
    const command = rootCommand(["node", "first-tree", "--debug"]);
    const action = vi.fn(async () => undefined);
    const wrapped = withCommandContext(action);

    await wrapped.call(command);

    expect(action).toHaveBeenCalledWith(
      expect.objectContaining({ options: { json: false, debug: true, quiet: false } }),
    );
  });
});
