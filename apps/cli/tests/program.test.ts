import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command, CommanderError } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { withCommandContext } from "../src/commands/context.js";
import { inspectCurrentWorkingTree } from "../src/commands/tree/inspect.js";
import { buildSourceIntegrationBlock } from "../src/commands/tree/source-integration.js";
import { statusCommand as treeStatusCommand } from "../src/commands/tree/status.js";
import type { CommandAction, CommandContext, GlobalOptions } from "../src/commands/types.js";
import { createProgram, main } from "../src/index.js";

const runGitHubScanMock = vi.hoisted(() => vi.fn().mockResolvedValue(0));
vi.mock("@first-tree/github-scan", () => ({ runGitHubScan: runGitHubScanMock }));

type ProgramRunResult = {
  code: number;
  stderr: string;
  stdout: string;
};

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "first-tree-cli-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();

    if (dir !== undefined) {
      rmSync(dir, { force: true, recursive: true });
    }
  }

  runGitHubScanMock.mockReset();
  runGitHubScanMock.mockResolvedValue(0);
});

const hubCommandMessages: Array<{
  args: string[];
  message: string;
}> = [
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
    expect(result.stdout.trim()).toBe("0.4.0-alpha.1");
  });

  it("prints root help with an all-commands appendix", async () => {
    const result = await runProgram(["--help"], "0.0.0-test");

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: first-tree");
    expect(result.stdout).toContain("CLI for Context Tree, GitHub Scan, and Hub workflows.");
    expect(result.stdout).toContain("--json");
    expect(result.stdout).toContain("-d, --debug");
    expect(result.stdout).toContain("-q, --quiet");
    expect(result.stdout).toContain("All commands:");
    expect(result.stdout).toContain("first-tree tree inspect");
    expect(result.stdout).toContain("first-tree tree skill install");
    expect(result.stdout).toContain("first-tree github scan");
    expect(result.stdout).toContain("first-tree hub start");
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
    const githubCommand = program.commands.find((command) => command.name() === "github");

    expect(githubCommand).toBeDefined();
    githubCommand?.description("");

    const result = await runConfiguredProgram(program, ["--help"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("\n  first-tree github\n");
  });

  it("prints successful help for a bare command group", async () => {
    const result = await runProgram(["tree"], "0.0.0-test");

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: first-tree tree");
    expect(result.stdout).toContain("inspect");
    expect(result.stdout).toContain("workspace");
    expect(result.stdout).toContain("skill");
    expect(result.stdout).not.toContain("All commands:");
  });

  it("prints help for a bare nested command group", async () => {
    const result = await runProgram(["tree", "skill"], "0.0.0-test");

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: first-tree tree skill");
    expect(result.stdout).toContain("install");
    expect(result.stdout).toContain("doctor");
  });

  it("delegates unknown group subcommands to Commander suggestions", async () => {
    const result = await runProgram(["tree", "inspec"], "0.0.0-test");

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error: unknown command 'inspec'");
    expect(result.stderr).toContain("(Did you mean inspect?)");
  });

  it("delegates unknown github subcommands to Commander suggestions", async () => {
    const result = await runProgram(["github", "scna"], "0.0.0-test");

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error: unknown command 'scna'");
    expect(result.stderr).toContain("(Did you mean scan?)");
  });

  it("passes default global options to a group subcommand action", async () => {
    const { action, result } = await runWithTreeStatusAction(["tree", "status"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expectActionContext(action, "status", {
      json: false,
      debug: false,
      quiet: false,
    });
  });

  it("passes json global options to a group subcommand action", async () => {
    const { action, result } = await runWithTreeStatusAction(["tree", "status", "--json"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expectActionContext(action, "status", {
      json: true,
      debug: false,
      quiet: false,
    });
  });

  it("lets quiet win when it follows debug", async () => {
    const { action, result } = await runWithTreeStatusAction(["tree", "status", "-d", "-q"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expectActionContext(action, "status", {
      json: false,
      debug: false,
      quiet: true,
    });
  });

  it("lets later global options win across command positions", async () => {
    const { action, result } = await runWithTreeStatusAction(["-d", "tree", "status", "-q"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expectActionContext(action, "status", {
      json: false,
      debug: false,
      quiet: true,
    });
  });

  it("lets debug win when it follows quiet", async () => {
    const { action, result } = await runWithTreeStatusAction(["tree", "status", "-q", "-d"]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expectActionContext(action, "status", {
      json: false,
      debug: true,
      quiet: false,
    });
  });

  it("normalizes clustered short options by order", async () => {
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

  for (const { args, message } of hubCommandMessages) {
    it(`fails ${args.join(" ")} in process`, async () => {
      const result = await runProgram(args, "0.0.0-test");

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(message);
      expect(result.stderr).toContain("Usage: first-tree hub");
    });
  }

  it("reports a missing shared tree for workspace sync in process", async () => {
    const root = makeTempDir();
    mkdirSync(join(root, "repo-a"));
    mkdirSync(join(root, "repo-b"));
    writeFileSync(join(root, "repo-a", ".git"), "gitdir: /tmp/a\n");
    writeFileSync(join(root, "repo-b", ".git"), "gitdir: /tmp/b\n");

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const previousCwd = process.cwd();
    const previousExitCode = process.exitCode;
    process.chdir(root);

    try {
      const result = await runProgram(["tree", "workspace", "sync"], "0.0.0-test");

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(error).toHaveBeenCalledWith(
        "Could not resolve the shared tree for this workspace. Pass --tree-path or --tree-url, or bind the workspace root first.",
      );
    } finally {
      process.chdir(previousCwd);
      process.exitCode = previousExitCode;
    }
  });

  it("installs managed SessionStart hooks in process", async () => {
    const root = makeTempDir();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const previousCwd = process.cwd();
    process.chdir(root);

    try {
      const result = await runProgram(["tree", "install-claude-code-hook"], "0.0.0-test");

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("");
      expect(log).toHaveBeenCalled();
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("generates CODEOWNERS in process", async () => {
    const root = makeTempDir();
    mkdirSync(join(root, "members", "alice"), { recursive: true });
    writeFileSync(
      join(root, "NODE.md"),
      `---\ntitle: Context Tree\nowners: [alice]\n---\n\n# Context Tree\n`,
    );
    writeFileSync(
      join(root, "members", "NODE.md"),
      `---\ntitle: Members\nowners: [alice]\n---\n\n# Members\n`,
    );
    writeFileSync(
      join(root, "members", "alice", "NODE.md"),
      `---\ntitle: Alice\nowners: [alice]\ntype: human\nrole: owner\ndomains: [core]\n---\n\n# Alice\n`,
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const previousCwd = process.cwd();
    process.chdir(root);

    try {
      const result = await runProgram(["tree", "generate-codeowners"], "0.0.0-test");

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("");
      expect(log).toHaveBeenCalledWith("Wrote .github/CODEOWNERS");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("emits inject-context payload in process", async () => {
    const root = makeTempDir();
    writeFileSync(join(root, "NODE.md"), "# Root\nbody\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const previousCwd = process.cwd();
    process.chdir(root);

    try {
      const result = await runProgram(["tree", "inject-context"], "0.0.0-test");

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("");
      const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(payload.hookSpecificOutput.hookEventName).toBe("SessionStart");
      expect(payload.hookSpecificOutput.additionalContext).toContain("# Root");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("accepts the deprecated --skip-version-check flag for hook compatibility", async () => {
    const root = makeTempDir();
    writeFileSync(join(root, "NODE.md"), "# Root\nbody\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const previousCwd = process.cwd();
    process.chdir(root);

    try {
      const result = await runProgram(
        ["tree", "inject-context", "--skip-version-check"],
        "0.0.0-test",
      );

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(payload.hookSpecificOutput.hookEventName).toBe("SessionStart");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("bootstraps a tree repo in process", async () => {
    const treeRoot = makeTempDir();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const previousCwd = process.cwd();
    process.chdir(treeRoot);

    try {
      const result = await runProgram(["tree", "bootstrap", "--here"], "0.0.0-test");

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("");
      expect(log).toHaveBeenCalled();
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("classifies an unbound git repo during inspect", () => {
    const root = makeTempDir();
    writeFileSync(join(root, ".git"), "gitdir: /tmp/mock\n");

    const result = inspectCurrentWorkingTree(root);

    expect(result.classification).toBe("git-repo");
    expect(result.rootKind).toBe("git-repo");
    expect(result.rootPath).toBe(root);
    expect(result.binding).toBeUndefined();
  });

  it("classifies a bound source repo during inspect", () => {
    const root = makeTempDir();
    mkdirSync(join(root, ".first-tree"), { recursive: true });
    writeFileSync(join(root, ".git"), "gitdir: /tmp/mock\n");
    writeFileSync(
      join(root, ".first-tree", "source.json"),
      `${JSON.stringify(
        {
          bindingMode: "shared-source",
          scope: "repo",
          tree: {
            entrypoint: ".",
            remoteUrl: "https://github.com/agent-team-foundation/first-tree-context.git",
            treeRepoName: "first-tree-context",
            treeMode: "shared",
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = inspectCurrentWorkingTree(root);

    expect(result.classification).toBe("source-repo");
    expect(result.binding?.bindingMode).toBe("shared-source");
    expect(result.binding?.treeRepo).toBe("agent-team-foundation/first-tree-context");
  });

  it("dispatches bare `github scan` to runGitHubScan with empty args", async () => {
    runGitHubScanMock.mockClear();
    runGitHubScanMock.mockResolvedValue(0);
    const previousExitCode = process.exitCode;
    process.exitCode = 0;

    try {
      const result = await runProgram(["github", "scan"], "0.0.0-test");

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(runGitHubScanMock).toHaveBeenCalledTimes(1);
      expect(runGitHubScanMock).toHaveBeenCalledWith([]);
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("transparently passes github scan args through when no binding is needed", async () => {
    runGitHubScanMock.mockClear();
    runGitHubScanMock.mockResolvedValue(0);
    const previousExitCode = process.exitCode;
    process.exitCode = 0;

    try {
      await runProgram(["github", "scan", "status", "--allow-repo", "foo"], "0.0.0-test");

      expect(runGitHubScanMock).toHaveBeenCalledWith(["status", "--allow-repo", "foo"]);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("forwards --help to runGitHubScan when invoked under github scan", async () => {
    runGitHubScanMock.mockClear();
    runGitHubScanMock.mockResolvedValue(0);
    const previousExitCode = process.exitCode;
    process.exitCode = 0;

    try {
      await runProgram(["github", "scan", "--help"], "0.0.0-test");

      expect(runGitHubScanMock).toHaveBeenCalledWith(["--help"]);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("propagates non-zero runGitHubScan exit code via process.exitCode", async () => {
    runGitHubScanMock.mockClear();
    runGitHubScanMock.mockResolvedValue(7);
    const previousExitCode = process.exitCode;
    process.exitCode = 0;

    try {
      await runProgram(["github", "scan", "doctor"], "0.0.0-test");

      expect(runGitHubScanMock).toHaveBeenCalledWith(["doctor"]);
      expect(process.exitCode).toBe(7);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("blocks github scan poll without a binding", async () => {
    const root = makeTempDir();
    runGitHubScanMock.mockClear();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    const previousCwd = process.cwd();
    process.exitCode = 0;

    try {
      process.chdir(root);
      await runProgram(["github", "scan", "poll", "--allow-repo", "owner/repo"], "0.0.0-test");

      expect(runGitHubScanMock).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(error).toHaveBeenCalledOnce();
      expect(String(error.mock.calls[0]?.[0])).toContain("requires a bound tree repo");
    } finally {
      process.chdir(previousCwd);
      process.exitCode = previousExitCode;
    }
  });

  it("accepts an explicit --tree-repo override for github scan and strips it before dispatch", async () => {
    runGitHubScanMock.mockClear();
    const previousTreeRepo = process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO;
    delete process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO;
    runGitHubScanMock.mockImplementation(async () => {
      expect(process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO).toBe(
        "agent-team-foundation/first-tree-context",
      );
      return 0;
    });
    const previousExitCode = process.exitCode;
    process.exitCode = 0;

    try {
      await runProgram(
        [
          "github",
          "scan",
          "poll",
          "--allow-repo",
          "owner/repo",
          "--tree-repo",
          "agent-team-foundation/first-tree-context",
        ],
        "0.0.0-test",
      );

      expect(runGitHubScanMock).toHaveBeenCalledWith(["poll", "--allow-repo", "owner/repo"]);
      expect(process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO).toBeUndefined();
    } finally {
      if (previousTreeRepo === undefined) {
        delete process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO;
      } else {
        process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO = previousTreeRepo;
      }
      process.exitCode = previousExitCode;
    }
  });

  it("resolves github scan binding from managed AGENTS.md metadata", async () => {
    const root = makeTempDir();
    writeFileSync(
      join(root, "AGENTS.md"),
      `${buildSourceIntegrationBlock("context", {
        bindingMode: "shared-source",
        entrypoint: "/repos/app",
        treeMode: "shared",
        treeRepoName: "context",
        treeRepoUrl: "https://github.com/acme/context.git",
      })}\n`,
    );

    runGitHubScanMock.mockClear();
    const previousTreeRepo = process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO;
    delete process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO;
    runGitHubScanMock.mockImplementation(async () => {
      expect(process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO).toBe("acme/context");
      return 0;
    });
    const previousExitCode = process.exitCode;
    const previousCwd = process.cwd();
    process.exitCode = 0;

    try {
      process.chdir(root);
      await runProgram(["github", "scan", "poll", "--allow-repo", "owner/repo"], "0.0.0-test");

      expect(runGitHubScanMock).toHaveBeenCalledWith(["poll", "--allow-repo", "owner/repo"]);
      expect(process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO).toBeUndefined();
    } finally {
      if (previousTreeRepo === undefined) {
        delete process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO;
      } else {
        process.env.FIRST_TREE_GITHUB_SCAN_TREE_REPO = previousTreeRepo;
      }
      process.chdir(previousCwd);
      process.exitCode = previousExitCode;
    }
  });

  it("runs main with an explicit argv", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await main(["node", "first-tree", "tree", "help", "onboarding"]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("first-tree tree help onboarding"));
  });

  it("installs shipped skills and lists them with json output", async () => {
    const root = makeTempDir();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const installResult = await runProgram(
      ["tree", "skill", "install", "--root", root],
      "0.0.0-test",
    );
    const listResult = await runProgram(
      ["--json", "tree", "skill", "list", "--root", root],
      "0.0.0-test",
    );

    expect(installResult.code).toBe(0);
    expect(listResult.code).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain("Installed 6 shipped first-tree skills");
    expect(String(log.mock.calls[1]?.[0])).toContain('"name": "first-tree"');
    expect(String(log.mock.calls[1]?.[0])).toContain('"name": "first-tree-onboarding"');
    expect(String(log.mock.calls[1]?.[0])).toContain('"name": "github-scan"');
    expect(String(log.mock.calls[1]?.[0])).toContain('"installed": true');
  });

  it("reports doctor failures before install and success after install", async () => {
    const root = makeTempDir();
    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const failingDoctorResult = await runProgram(
        ["tree", "skill", "doctor", "--root", root],
        "0.0.0-test",
      );

      expect(failingDoctorResult.code).toBe(0);
      expect(
        log.mock.calls.some((call) =>
          String(call[0]).includes("=== first-tree tree skill doctor ==="),
        ),
      ).toBe(true);
      expect(log.mock.calls.some((call) => String(call[0]).includes("FAIL first-tree"))).toBe(true);
      expect(process.exitCode).toBe(1);

      process.exitCode = 0;

      const installResult = await runProgram(
        ["tree", "skill", "install", "--root", root],
        "0.0.0-test",
      );
      const passingDoctorResult = await runProgram(
        ["tree", "skill", "doctor", "--root", root],
        "0.0.0-test",
      );

      expect(installResult.code).toBe(0);
      expect(passingDoctorResult.code).toBe(0);
      expect(log.mock.calls.some((call) => String(call[0]).includes("OK first-tree"))).toBe(true);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
