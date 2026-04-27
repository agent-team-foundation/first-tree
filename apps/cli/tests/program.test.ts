import { Command, CommanderError } from "commander";
import { describe, expect, it, vi } from "vitest";

import { withCommandContext } from "../src/commands/context.js";
import { initCommand } from "../src/commands/init.js";
import { statusCommand as treeStatusCommand } from "../src/commands/tree/status.js";
import type { CommandAction, CommandContext, GlobalOptions } from "../src/commands/types.js";
import { createProgram, main } from "../src/index.js";

type ProgramRunResult = {
  code: number;
  stderr: string;
  stdout: string;
};

const commandMessages: Array<{
  args: string[];
  message: string;
}> = [
  {
    args: ["init"],
    message: "first-tree init is not implemented yet.",
  },
  {
    args: ["tree", "inspect"],
    message: "first-tree tree inspect is not implemented yet.",
  },
  {
    args: ["tree", "status"],
    message: "first-tree tree status is not implemented yet.",
  },
  {
    args: ["tree", "generate-codeowners"],
    message: "first-tree tree generate-codeowners is not implemented yet.",
  },
  {
    args: ["tree", "install-claude-code-hook"],
    message: "first-tree tree install-claude-code-hook is not implemented yet.",
  },
  {
    args: ["hub", "start"],
    message: "first-tree hub start is not implemented yet.",
  },
  {
    args: ["hub", "stop"],
    message: "first-tree hub stop is not implemented yet.",
  },
  {
    args: ["hub", "doctor"],
    message: "first-tree hub doctor is not implemented yet.",
  },
  {
    args: ["hub", "status"],
    message: "first-tree hub status is not implemented yet.",
  },
  {
    args: ["breeze", "install"],
    message: "first-tree breeze install is not implemented yet.",
  },
  {
    args: ["breeze", "start"],
    message: "first-tree breeze start is not implemented yet.",
  },
  {
    args: ["breeze", "stop"],
    message: "first-tree breeze stop is not implemented yet.",
  },
  {
    args: ["breeze", "status"],
    message: "first-tree breeze status is not implemented yet.",
  },
  {
    args: ["breeze", "doctor"],
    message: "first-tree breeze doctor is not implemented yet.",
  },
  {
    args: ["breeze", "poll"],
    message: "first-tree breeze poll is not implemented yet.",
  },
  {
    args: ["gardener", "sync"],
    message: "first-tree gardener sync is not implemented yet.",
  },
  {
    args: ["gardener", "status"],
    message: "first-tree gardener status is not implemented yet.",
  },
  {
    args: ["gardener", "install"],
    message: "first-tree gardener install is not implemented yet.",
  },
];

async function runConfiguredProgram(program: Command, args: string[]): Promise<ProgramRunResult> {
  let stdout = "";
  let stderr = "";

  const configureCommand = (command: Command) => {
    command.exitOverride();
    command.configureOutput({
      writeOut: (value) => {
        stdout += value;
      },
      writeErr: (value) => {
        stderr += value;
      },
    });

    for (const childCommand of command.commands) {
      configureCommand(childCommand);
    }
  };

  configureCommand(program);

  try {
    await program.parseAsync(args, { from: "user" });

    return {
      code: 0,
      stderr,
      stdout,
    };
  } catch (error) {
    if (error instanceof CommanderError) {
      return {
        code: error.exitCode,
        stderr,
        stdout,
      };
    }

    throw error;
  }
}

async function runProgram(args: string[], version?: string): Promise<ProgramRunResult> {
  const program = version === undefined ? createProgram() : createProgram(version);

  return runConfiguredProgram(program, args);
}

async function runWithInitAction(
  args: string[],
): Promise<{ action: ReturnType<typeof vi.fn>; result: ProgramRunResult }> {
  const originalAction = initCommand.action;
  const action = vi.fn((_context: CommandContext) => {});

  initCommand.action = action;

  try {
    return {
      action,
      result: await runProgram(args, "0.0.0-test"),
    };
  } finally {
    initCommand.action = originalAction;
  }
}

async function runWithTreeStatusAction(
  args: string[],
): Promise<{ action: ReturnType<typeof vi.fn>; result: ProgramRunResult }> {
  const originalAction = treeStatusCommand.action;
  const action = vi.fn((_context: CommandContext) => {});

  treeStatusCommand.action = action as CommandAction;

  try {
    return {
      action,
      result: await runProgram(args, "0.0.0-test"),
    };
  } finally {
    treeStatusCommand.action = originalAction;
  }
}

async function runWithProbeAction(
  args: string[],
): Promise<{ action: ReturnType<typeof vi.fn>; result: ProgramRunResult }> {
  const program = createProgram("0.0.0-test");
  const action = vi.fn((_context: CommandContext) => {});

  program.command("probe [values...]").action(withCommandContext(action as CommandAction));

  return {
    action,
    result: await runConfiguredProgram(program, args),
  };
}

function expectActionContext(
  action: ReturnType<typeof vi.fn>,
  commandName: string,
  options: GlobalOptions,
): void {
  expect(action).toHaveBeenCalledOnce();

  const context = action.mock.calls[0]?.[0] as CommandContext | undefined;

  expect(context?.command.name()).toBe(commandName);
  expect(context?.options).toEqual(options);
}

describe("first-tree program", () => {
  it("reads the package version when no version is injected", async () => {
    const result = await runProgram(["--version"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("0.3.1-alpha");
  });

  it("prints root help with an all-commands appendix", async () => {
    const result = await runProgram(["--help"], "0.0.0-test");

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: first-tree");
    expect(result.stdout).toContain(
      "CLI for initializing and maintaining first-tree context trees.",
    );
    expect(result.stdout).toContain("--json");
    expect(result.stdout).toContain("-d, --debug");
    expect(result.stdout).toContain("-q, --quiet");
    expect(result.stdout).toContain("All commands:");
    expect(result.stdout).toContain("first-tree tree inspect");
    expect(result.stdout).toContain("first-tree hub start");
    expect(result.stdout).toContain("first-tree breeze poll");
    expect(result.stdout).toContain("first-tree gardener sync");
  });

  it("omits the all-commands appendix when no commands are registered", async () => {
    const program = createProgram("0.0.0-test");

    program.commands.splice(0);

    const result = await runConfiguredProgram(program, ["--help"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: first-tree");
    expect(result.stdout).not.toContain("All commands:");
  });

  it("formats command help entries that do not have descriptions", async () => {
    const program = createProgram("0.0.0-test");
    const initCommand = program.commands.find((command) => command.name() === "init");

    expect(initCommand).toBeDefined();
    initCommand?.description("");

    const result = await runConfiguredProgram(program, ["--help"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("\n  first-tree init\n");
  });

  it("prints successful help for a bare command group", async () => {
    const result = await runProgram(["tree"], "0.0.0-test");

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: first-tree tree");
    expect(result.stdout).toContain("inspect");
    expect(result.stdout).toContain("install-claude-code-hook");
    expect(result.stdout).not.toContain("All commands:");
  });

  it("delegates unknown group subcommands to Commander suggestions", async () => {
    const result = await runProgram(["tree", "inspec"], "0.0.0-test");

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error: unknown command 'inspec'");
    expect(result.stderr).toContain("(Did you mean inspect?)");
  });

  it("passes default global options to a root command action", async () => {
    const { action, result } = await runWithInitAction(["init"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expectActionContext(action, "init", {
      json: false,
      debug: false,
      quiet: false,
    });
  });

  it("passes json global options to a root command action", async () => {
    const { action, result } = await runWithInitAction(["init", "--json"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expectActionContext(action, "init", {
      json: true,
      debug: false,
      quiet: false,
    });
  });

  it("lets quiet win when it follows debug", async () => {
    const { action, result } = await runWithInitAction(["init", "-d", "-q"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expectActionContext(action, "init", {
      json: false,
      debug: false,
      quiet: true,
    });
  });

  it("lets later global options win across command positions", async () => {
    const { action, result } = await runWithInitAction(["-d", "init", "-q"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expectActionContext(action, "init", {
      json: false,
      debug: false,
      quiet: true,
    });
  });

  it("lets debug win when it follows quiet", async () => {
    const { action, result } = await runWithInitAction(["init", "-q", "-d"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expectActionContext(action, "init", {
      json: false,
      debug: true,
      quiet: false,
    });
  });

  it("normalizes debug and quiet precedence for group subcommands", async () => {
    const { action, result } = await runWithTreeStatusAction([
      "tree",
      "status",
      "--debug",
      "--quiet",
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expectActionContext(action, "status", {
      json: false,
      debug: false,
      quiet: true,
    });
  });

  it("normalizes clustered short debug and quiet options by order", async () => {
    const { action, result } = await runWithTreeStatusAction(["tree", "status", "-qd"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expectActionContext(action, "status", {
      json: false,
      debug: true,
      quiet: false,
    });
  });

  it("normalizes clustered short options when quiet follows debug", async () => {
    const { action, result } = await runWithTreeStatusAction(["tree", "status", "-dq"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expectActionContext(action, "status", {
      json: false,
      debug: false,
      quiet: true,
    });
  });

  it("stops debug and quiet precedence scanning after the option terminator", async () => {
    const { action, result } = await runWithProbeAction(["probe", "-d", "--", "-q"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expectActionContext(action, "probe", {
      json: false,
      debug: true,
      quiet: false,
    });
  });

  for (const { args, message } of commandMessages) {
    it(`runs ${args.join(" ")} in process`, async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const result = await runProgram(args, "0.0.0-test");

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("");
      expect(log).toHaveBeenCalledWith(message);
    });
  }

  it("runs main with an explicit argv", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await main(["node", "first-tree", "init"]);

    expect(log).toHaveBeenCalledWith("first-tree init is not implemented yet.");
  });
});
