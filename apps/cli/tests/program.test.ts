import { Command, CommanderError } from "commander";
import { describe, expect, it, vi } from "vitest";

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
