/**
 * `first-tree auto install` — first-run setup for the auto daemon.
 *
 * Creates `~/.first-tree/auto/config.yaml` with defaults (if absent) and hands
 * off daemon startup to `first-tree auto start`.
 *
 * The pre-Phase-9 bash installer also symlinked three standalone skills
 * into `~/.claude/skills`. That step is obsolete: the four first-tree
 * skills now install into the caller's repo via `first-tree tree init`
 * / `bind` / `upgrade` and do not require a separate machine-wide
 * symlink step.
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

const DEFAULT_CONFIG = `# auto configuration
poll_interval_sec: 60
task_timeout_sec: 1800
log_level: info
http_port: 7879
host: github.com
`;

export interface InstallDeps {
  autoDir?: string;
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
      args: [entrypoint, "auto", "start"],
    };
  }
  return { cmd: "first-tree", args: ["auto", "start"] };
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
    (deps.write ?? console.log)(`usage: first-tree auto install

  Bootstraps the local auto daemon:

    1. Checks for gh, jq, and gh auth status
    2. Creates \`~/.first-tree/auto/config.yaml\` with defaults (if absent)
    3. Starts the daemon via \`first-tree auto start\`

  Required:
    ${REQUIRED_ALLOW_REPO_USAGE}   Explicit repo scope for the daemon startup

  Environment:
    AUTO_DIR              Override \`~/.first-tree/auto\` (store root)
`);
    return 0;
  }

  const write = deps.write ?? ((text: string) => process.stdout.write(text + "\n"));
  const checkCommand = deps.checkCommand ?? defaultCheckCommand;
  const checkGhAuth = deps.checkGhAuth ?? defaultCheckGhAuth;
  const spawn = deps.spawn ?? spawnSync;
  const autoDir =
    deps.autoDir ?? process.env.AUTO_DIR ?? join(homedir(), ".first-tree", "auto");
  const startCommand = deps.startCommand ?? resolveSelfStartCommand();
  try {
    requireExplicitRepoFilter(parseAllowRepoArg(args));
  } catch (err) {
    write(
      `ERROR: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  write("=== auto setup ===");
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
  if (!checkCommand("jq")) {
    write(
      "ERROR: jq is not installed. Install it: brew install jq (macOS) or apt install jq (Linux)",
    );
    return 1;
  }
  write("  gh CLI: OK");
  write("  gh auth: OK");
  write("  jq: OK");
  write("");

  write(`Setting up ${autoDir}...`);
  mkdirSync(autoDir, { recursive: true });
  const configPath = join(autoDir, "config.yaml");
  if (existsSync(configPath)) {
    write(`  Config already exists at ${configPath}`);
  } else {
    writeFileSync(configPath, DEFAULT_CONFIG);
    write(`  Created default config at ${configPath}`);
  }
  write("");

  write("Starting the auto daemon...");
  const result = spawn(startCommand.cmd, [...startCommand.args, ...args], {
    stdio: "inherit",
  });
  if (result.status === 0) {
    write("  Daemon started");
  } else {
    write(
      "  WARN: daemon start failed; rerun `first-tree auto start --allow-repo owner/repo` manually",
    );
  }
  write("");

  write("=== auto setup complete ===");
  write("");
  write("  Dashboard:  http://127.0.0.1:7879");
  write("  Status:     first-tree auto status");
  write("  Stop:       first-tree auto stop");
  write("  Inspect:    first-tree auto doctor");

  return 0;
}
