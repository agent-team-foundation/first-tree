/**
 * `first-tree github scan install` — first-run setup for the github-scan daemon.
 *
 * Creates `~/.first-tree/github-scan/config.yaml` with defaults (if absent) and hands
 * off daemon startup to `first-tree github scan start`.
 *
 * This package is invoked through the umbrella CLI. It only prepares the local
 * daemon runtime.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  parseAllowRepoArg,
  requireExplicitRepoFilter,
  REQUIRED_ALLOW_REPO_USAGE,
} from "../runtime/allow-repo.js";

const DEFAULT_CONFIG = `# github-scan configuration
poll_interval_sec: 60
task_timeout_sec: 1800
log_level: info
http_port: 7878
host: github.com
`;

export interface InstallDeps {
  githubScanDir?: string;
  write?: (text: string) => void;
  spawn?: typeof spawnSync;
  checkCommand?: (cmd: string) => boolean;
  checkGhAuth?: () => boolean;
  startCommand?: {
    cmd: string;
    args: string[];
  };
}

export function resolveSelfStartCommand(
  entrypoint: string | undefined = process.argv[1],
): { cmd: string; args: string[] } {
  if (entrypoint && entrypoint.length > 0) {
    return {
      cmd: process.execPath,
      args: [entrypoint, "github", "scan", "start"],
    };
  }
  return { cmd: "first-tree", args: ["github", "scan", "start"] };
}

function defaultCheckCommand(cmd: string): boolean {
  const result = spawnSync("command", ["-v", cmd], {
    shell: true,
    stdio: "ignore",
  });
  return result.status === 0;
}

function defaultCheckGhAuth(): boolean {
  const result = spawnSync("gh", ["auth", "status"], { stdio: "ignore" });
  return result.status === 0;
}

export function runInstall(
  args: readonly string[],
  deps: InstallDeps = {},
): number {
  if (args.length > 0 && (args[0] === "--help" || args[0] === "-h")) {
    (deps.write ?? console.log)(`usage: first-tree github scan install

  Bootstraps the local github-scan daemon:

    1. Checks for gh and gh auth status
    2. Creates \`~/.first-tree/github-scan/config.yaml\` with defaults (if absent)
    3. Starts the daemon via \`first-tree github scan start\`

  Required:
    ${REQUIRED_ALLOW_REPO_USAGE}   Explicit repo scope for the daemon startup

  Environment:
    GITHUB_SCAN_DIR            Override \`~/.first-tree/github-scan\` (store root)
`);
    return 0;
  }

  const write = deps.write ?? ((text: string) => process.stdout.write(text + "\n"));
  const checkCommand = deps.checkCommand ?? defaultCheckCommand;
  const checkGhAuth = deps.checkGhAuth ?? defaultCheckGhAuth;
  const spawn = deps.spawn ?? spawnSync;
  const githubScanDir =
    deps.githubScanDir ?? process.env.GITHUB_SCAN_DIR ?? join(homedir(), ".first-tree/github-scan");
  const startCommand = deps.startCommand ?? resolveSelfStartCommand();
  try {
    requireExplicitRepoFilter(parseAllowRepoArg(args));
  } catch (err) {
    write(
      `ERROR: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  write("=== github-scan setup ===");
  write("");
  write("Checking prerequisites...");

  if (!checkCommand("gh")) {
    write("ERROR: gh CLI is not installed. Install it: https://cli.github.com/");
    return 1;
  }
  if (!checkGhAuth()) {
    write("ERROR: gh is not authenticated. Run `gh auth login` first.");
    return 1;
  }
  write("  gh CLI: OK");
  write("  gh auth: OK");
  write("");

  write(`Setting up ${githubScanDir}...`);
  mkdirSync(githubScanDir, { recursive: true });
  const configPath = join(githubScanDir, "config.yaml");
  if (existsSync(configPath)) {
    write(`  Config already exists at ${configPath}`);
  } else {
    writeFileSync(configPath, DEFAULT_CONFIG);
    write(`  Created default config at ${configPath}`);
  }
  write("");

  write("Starting the github-scan daemon...");
  const result = spawn(startCommand.cmd, [...startCommand.args, ...args], {
    stdio: "inherit",
  });
  if (result.status === 0) {
    write("  Daemon started");
  } else {
    write(
      "  WARN: daemon start failed; rerun `first-tree github scan start --allow-repo owner/repo` manually",
    );
  }
  write("");

  write("=== github-scan setup complete ===");
  write("");
  write("  Dashboard:  http://127.0.0.1:7878");
  write("  Status:     first-tree github scan status");
  write("  Stop:       first-tree github scan stop");
  write("  Inspect:    first-tree github scan doctor");

  return 0;
}
