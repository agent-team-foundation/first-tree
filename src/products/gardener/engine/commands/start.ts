/**
 * `first-tree gardener start` — spawn the gardener daemon in the
 * background. Writes `~/.gardener/config.json` from the supplied args,
 * then boots a launchd job on macOS (or a detached `spawn` elsewhere)
 * that runs `first-tree gardener daemon`.
 */

import { spawn } from "node:child_process";
import { openSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, userInfo } from "node:os";
import {
  buildDaemonConfig,
  configPath,
  parseDurationMs,
  resolveGardenerDir,
  writeDaemonConfig,
} from "../daemon/config.js";
import {
  bootstrapLaunchdJob,
  gardenerLaunchdLabel,
  gardenerLaunchdPlistPath,
  supportsLaunchd,
} from "../daemon/launchd.js";

export const START_USAGE = `usage: first-tree gardener start --tree-path <path> --code-repo <owner/repo> [--code-repo …] [--gardener-interval 5m] [--sync-interval 1h] [--assign-owners] [--sync-apply]

Bring up the gardener daemon in the background.

The daemon runs two schedules:
  gardener-sweep  invokes \`gardener comment --merged-since 2×interval\`
                  against the tree path; handles open PR verdicts and
                  merge→tree-issue creation across all configured code
                  repos.
  sync-sweep      invokes \`gardener sync\` (or \`gardener sync --apply\`
                  when --sync-apply is set) against the tree path;
                  detects drift and optionally opens tree PRs.

Options:
  --tree-path <path>          Required. Local checkout of the bound tree repo.
  --code-repo <owner/name>    Required (repeatable). Source repos to monitor.
                              These are written to target_repos in the
                              tree repo's .claude/gardener-config.yaml so
                              scan mode picks them up.
  --gardener-interval <dur>   Default 5m. Accepts s/m/h/d suffixes.
  --sync-interval <dur>       Default 1h.
  --assign-owners             Pass --assign-owners to gardener comment
                              so merge→tree-issue creations auto-assign
                              NODE owners.
  --sync-apply                Run the sync sweep in --apply mode
                              (opens tree PRs). Default: detect only.
  --help, -h                  Show this help.

Environment:
  GARDENER_DIR   Override ~/.gardener for state/logs/plist (test hook).
`;

export interface RunStartOptions {
  write?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Set to true to skip actually booting — print plan only. */
  dryRun?: boolean;
}

interface ParsedStartFlags {
  help: boolean;
  treePath?: string;
  codeRepos: string[];
  gardenerInterval?: string;
  syncInterval?: string;
  assignOwners: boolean;
  syncApply: boolean;
  dryRun: boolean;
  unknown?: string;
}

function parseStartFlags(args: readonly string[]): ParsedStartFlags {
  const out: ParsedStartFlags = {
    help: false,
    codeRepos: [],
    assignOwners: false,
    syncApply: false,
    dryRun: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--help" || a === "-h") { out.help = true; continue; }
    if (a === "--dry-run") { out.dryRun = true; continue; }
    if (a === "--assign-owners") { out.assignOwners = true; continue; }
    if (a === "--sync-apply") { out.syncApply = true; continue; }
    if (a === "--tree-path") { out.treePath = args[++i]; continue; }
    if (a === "--code-repo") {
      const val = args[++i];
      if (typeof val !== "string" || val.length === 0) {
        out.unknown = "--code-repo requires owner/name";
        return out;
      }
      out.codeRepos.push(val);
      continue;
    }
    if (a === "--gardener-interval") { out.gardenerInterval = args[++i]; continue; }
    if (a === "--sync-interval") { out.syncInterval = args[++i]; continue; }
    out.unknown = a ?? "";
    return out;
  }
  return out;
}

export async function runStart(
  argv: readonly string[] = [],
  options: RunStartOptions = {},
): Promise<number> {
  const write = options.write ?? ((line) => process.stdout.write(line + "\n"));
  const env = options.env ?? process.env;

  const flags = parseStartFlags(argv);
  if (flags.help) {
    write(START_USAGE);
    return 0;
  }
  if (flags.unknown) {
    write(`Unknown start option: ${flags.unknown}`);
    write(START_USAGE);
    return 1;
  }
  if (!flags.treePath) {
    write("--tree-path is required");
    return 1;
  }
  if (flags.codeRepos.length === 0) {
    write("--code-repo is required (repeat for multiple repos)");
    return 1;
  }

  const gardenerIntervalMs = flags.gardenerInterval
    ? parseDurationMs(flags.gardenerInterval)
    : undefined;
  if (flags.gardenerInterval !== undefined && gardenerIntervalMs === null) {
    write(`--gardener-interval: could not parse "${flags.gardenerInterval}" (expected e.g. 5m, 300s, 1h)`);
    return 1;
  }
  const syncIntervalMs = flags.syncInterval
    ? parseDurationMs(flags.syncInterval)
    : undefined;
  if (flags.syncInterval !== undefined && syncIntervalMs === null) {
    write(`--sync-interval: could not parse "${flags.syncInterval}"`);
    return 1;
  }

  const config = buildDaemonConfig({
    treePath: flags.treePath,
    codeRepos: flags.codeRepos,
    gardenerIntervalMs: gardenerIntervalMs ?? undefined,
    syncIntervalMs: syncIntervalMs ?? undefined,
    assignOwners: flags.assignOwners,
    syncApply: flags.syncApply,
  });

  const configFilePath = flags.dryRun
    ? configPath(env)
    : writeDaemonConfig(config, env);
  const header = flags.dryRun
    ? `gardener daemon config (preview, not written): ${configFilePath}`
    : `gardener daemon config written: ${configFilePath}`;
  write(header);
  write(`  tree-path:          ${config.treePath}`);
  write(`  code-repos:         ${config.codeRepos.join(", ")}`);
  write(`  gardener-interval:  ${config.gardenerIntervalMs / 1000}s`);
  write(`  sync-interval:      ${config.syncIntervalMs / 1000}s`);
  write(`  merged-lookback:    ${config.mergedLookbackSeconds}s`);
  write(`  assign-owners:      ${config.assignOwners}`);
  write(`  sync-apply:         ${config.syncApply}`);

  if (flags.dryRun) {
    write("--dry-run: not booting daemon (config left untouched)");
    return 0;
  }

  const gardenerDir = resolveGardenerDir(env);
  mkdirSync(gardenerDir, { recursive: true });
  const logsDir = join(gardenerDir, "logs");
  mkdirSync(logsDir, { recursive: true });
  const nowSec = Math.floor(Date.now() / 1_000);
  const logPath = join(logsDir, `gardener-daemon-${nowSec}.log`);

  const entrypoint = process.argv[1];
  const programArgs = entrypoint
    ? [entrypoint, "gardener", "daemon"]
    : ["gardener", "daemon"];

  if (supportsLaunchd()) {
    const login = userInfo().username || env.USER || "user";
    const label = gardenerLaunchdLabel(login);
    const plistPath = gardenerLaunchdPlistPath(gardenerDir, label);
    try {
      bootstrapLaunchdJob({
        label,
        executable: process.execPath,
        arguments: programArgs,
        logPath,
        env: {
          HOME: homedir(),
          PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          GARDENER_DIR: gardenerDir,
          // Passthrough the classifier credentials when the caller has
          // them in their shell env. Without ANTHROPIC_API_KEY, gardener
          // comment refuses to post (PR #255). We add the vars only when
          // present so launchd doesn't record empty strings.
          ...(env.ANTHROPIC_API_KEY
            ? { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY }
            : {}),
          ...(env.GARDENER_CLASSIFIER_MODEL
            ? { GARDENER_CLASSIFIER_MODEL: env.GARDENER_CLASSIFIER_MODEL }
            : {}),
        },
        workingDirectory: config.treePath,
        plistPath,
      });
      write("gardener daemon started via launchd");
      write(`  plist:  ${plistPath}`);
      write(`  log:    ${logPath}`);
      write(`  label:  ${label}`);
      return 0;
    } catch (err) {
      write(
        `launchd bootstrap failed (${err instanceof Error ? err.message : String(err)}), falling back to detached spawn`,
      );
    }
  }

  const logFd = openSync(logPath, "a");
  const child = spawn(process.execPath, programArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: config.treePath,
    env: { ...env, GARDENER_DIR: gardenerDir },
  });
  child.unref();
  if (!child.pid) {
    write("failed to spawn detached gardener daemon");
    return 1;
  }
  write("gardener daemon started via detached spawn");
  write(`  pid:  ${child.pid}`);
  write(`  log:  ${logPath}`);
  return 0;
}
