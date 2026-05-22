import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { Command } from "commander";

import type { CommandModule } from "../types.js";

const TREE_REPO_ENV = "FIRST_TREE_GITHUB_SCAN_TREE_REPO";
const BINDING_REQUIRED_COMMANDS = new Set([
  "install",
  "start",
  "poll",
  "run",
  "daemon",
  "run-once",
]);

type SourceBinding = {
  tree?: {
    remoteUrl?: string;
  };
};

type TreeRepoParseResult = {
  forwardedArgs: string[];
  treeRepo?: string;
  error?: string;
};

function parseTreeRepoArg(args: readonly string[]): TreeRepoParseResult {
  const forwardedArgs: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === "--tree-repo") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        return {
          forwardedArgs,
          error: "first-tree github scan: missing value for `--tree-repo <owner/repo>`.",
        };
      }
      i += 1;
      return { forwardedArgs: [...forwardedArgs, ...args.slice(i + 1)], treeRepo: value };
    }

    if (arg?.startsWith("--tree-repo=")) {
      const value = arg.slice("--tree-repo=".length);
      if (value.length === 0) {
        return {
          forwardedArgs,
          error: "first-tree github scan: missing value for `--tree-repo <owner/repo>`.",
        };
      }
      return { forwardedArgs: [...forwardedArgs, ...args.slice(i + 1)], treeRepo: value };
    }

    forwardedArgs.push(arg);
  }

  return { forwardedArgs };
}

function findSourceJson(startDir: string): string | null {
  let dir = resolve(startDir);

  while (true) {
    const candidate = join(dir, ".first-tree", "source.json");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

function parseTreeRepoFromRemoteUrl(remoteUrl: string | undefined): string | undefined {
  if (!remoteUrl) {
    return undefined;
  }

  const trimmed = remoteUrl.trim().replace(/\/+$/u, "");
  if (trimmed.length === 0) {
    return undefined;
  }

  const httpsMatch = trimmed.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/u);
  if (!httpsMatch) {
    return undefined;
  }

  const owner = httpsMatch[1];
  const repo = httpsMatch[2];
  if (!owner || !repo) {
    return undefined;
  }

  return `${owner}/${repo}`;
}

function resolveBoundTreeRepo(cwd: string = process.cwd()): string | undefined {
  const sourceJsonPath = findSourceJson(cwd);
  if (!sourceJsonPath) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(readFileSync(sourceJsonPath, "utf8")) as SourceBinding;
    return parseTreeRepoFromRemoteUrl(parsed.tree?.remoteUrl);
  } catch {
    return undefined;
  }
}

function shouldRequireBinding(args: readonly string[]): boolean {
  const command = args[0];
  return typeof command === "string" && BINDING_REQUIRED_COMMANDS.has(command);
}

function missingBindingMessage(): string {
  return [
    "first-tree github scan: this command requires a bound tree repo.",
    "Run it from a source/workspace repo that already has `.first-tree/source.json`,",
    "or pass `--tree-repo <owner/repo>` explicitly.",
    "If this repo is not bound yet, start with `first-tree tree bind ...`.",
  ].join("\n");
}

export const githubScanCommand: CommandModule = {
  name: "scan",
  description: "Run GitHub scan commands.",
  register(program: Command): void {
    program
      .command("scan")
      .description("Run GitHub scan commands.")
      .argument("[args...]", "github scan sub-command and its arguments")
      .allowUnknownOption(true)
      .helpOption(false)
      .helpCommand(false)
      .action(async (scanArgs: string[]) => {
        const { runGitHubScan } = await import("../../../../../packages/github-scan/src/index.js");

        const parsed = parseTreeRepoArg(scanArgs);
        if (parsed.error) {
          process.stderr.write(`${parsed.error}\n`);
          process.exitCode = 1;
          return;
        }

        const treeRepo = parsed.treeRepo ?? resolveBoundTreeRepo();
        if (shouldRequireBinding(parsed.forwardedArgs) && !treeRepo) {
          process.stderr.write(`${missingBindingMessage()}\n`);
          process.exitCode = 1;
          return;
        }

        const previousTreeRepo = process.env[TREE_REPO_ENV];
        if (treeRepo) {
          process.env[TREE_REPO_ENV] = treeRepo;
        }

        try {
          const exitCode = await runGitHubScan(parsed.forwardedArgs);
          if (typeof exitCode === "number" && exitCode !== 0) {
            process.exitCode = exitCode;
          }
        } finally {
          if (treeRepo) {
            if (previousTreeRepo === undefined) {
              delete process.env[TREE_REPO_ENV];
            } else {
              process.env[TREE_REPO_ENV] = previousTreeRepo;
            }
          }
        }
      });
  },
};
