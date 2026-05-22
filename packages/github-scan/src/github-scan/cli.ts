/**
 * GitHub Scan CLI dispatcher.
 *
 * As of Phase 8 every github-scan subcommand runs on the TypeScript daemon.
 * `run` / `run-once` / `daemon` all route through `daemon/runner-skeleton.ts`;
 * the historical `github-scan-runner` Rust binary and the `--backend=` flag
 * have been retired.
 *
 * Lifecycle + diagnostic subcommands (Phase 6): `start`, `stop`,
 * `status`, `doctor`, `cleanup`, `poll-inbox`.
 *
 * Foreground loops (Phase 8): `run` = TS daemon forever; `run-once` =
 * one poll cycle + drain + exit. `daemon` is an alias for `run`.
 *
 * Heavy deps (child_process, ink, react, daemon modules) live in the
 * dynamically-imported command modules so `github-scan --help` stays lightweight.
 */

import { GITHUB_SCAN_VERSION } from "./version.js";

export const GITHUB_SCAN_USAGE = `usage: first-tree github scan <command>

  GitHub Scan is the GitHub notification daemon for first-tree. It polls
  your allowed repositories, keeps a local inbox under \`~/.first-tree/github-scan/\`, and
  dispatches work to per-task agent runners.

  Run \`first-tree github scan help <command>\` for command details.

Primary commands (start here):
  install               Run the first-run setup (creates config.yaml, then
                        starts the daemon; requires a tree binding and
                        \`--allow-repo\`
  start                 Launch the daemon in the background (launchd on macOS;
                        requires a tree binding and \`--allow-repo\`
  stop                  Stop the daemon and remove its lock
  status                Print daemon lock + runtime/status.env
  doctor                Diagnose the local install
  watch                 Live TUI: status board + activity feed
  poll                  Poll GitHub notifications once (requires a tree
                        binding; no daemon required)

Advanced commands (for agents or debugging):
  run, daemon           Run the broker loop in the foreground.
                        Humans should normally use \`start\` instead; requires
                        a tree binding and \`--allow-repo\`. \`daemon\` is an
                        alias invoked by launchd.
  run-once              Run one poll cycle, wait for drain, exit. Requires a
                        tree binding and \`--allow-repo\`.
  cleanup               Remove stale workspaces + expired claims
                        (only run if \`doctor\` suggests it).

Options:
  --help, -h            Show this help message
  --version, -V         Print the github-scan version

Environment:
  GITHUB_SCAN_DIR            Override \`~/.first-tree/github-scan\` (store root)
  GITHUB_SCAN_HOME           Override \`~/.first-tree/github-scan/runner\` (daemon private state)

Not shown above (hook/internal entry points — do not invoke directly):
  statusline            Claude Code statusline hook. Called by Claude Code via
                        the separate \`dist/github-scan-statusline.js\` bundle
                        for sub-30 ms cold start.
  status-manager        Internal helper used by the scan runner to manage
                        per-session status entries. No direct human/agent use.
  poll-inbox            Legacy alias for \`poll\`. Kept for existing scripts.
`;

const GITHUB_SCAN_INLINE_HELP: Partial<Record<string, string>> = {
  run: `usage: first-tree github scan run [options]

  Run the GitHub Scan daemon in the foreground until stopped.

  Common options:
    --allow-repo <csv>           Required: restrict work to owner/repo or owner/* patterns
    --poll-interval-secs <n>     Seconds between poll cycles
    --task-timeout-secs <n>      Per-task timeout
    --max-parallel <n>           Max concurrent agent tasks
    --search-limit <n>           Max search-derived candidates per cycle
    --agent-login <login>        GitHub login to treat as the agent (own-comment guard).
                                 Falls back to GITHUB_SCAN_AGENT_LOGIN, then config-file
                                 \`agent_login\`, then \`gh auth\` identity.
    --dry-run                    Schedule tasks without invoking agents
`,
  daemon: `usage: first-tree github scan daemon [options]

  Alias for \`first-tree github scan run\`. Still requires \`--allow-repo\`.

  Common options:
    --allow-repo <csv>           Required: restrict work to owner/repo or owner/* patterns
    --agent-login <login>        GitHub login to treat as the agent (own-comment guard).
                                 Falls back to GITHUB_SCAN_AGENT_LOGIN, then config-file
                                 \`agent_login\`, then \`gh auth\` identity.
    --dry-run                    Schedule tasks without invoking agents
`,
  "run-once": `usage: first-tree github scan run-once [options]

  Run one inbox poll plus one candidate-search cycle, wait for queued
  agent work to drain, then exit.

  Options:
    --allow-repo <csv>           Required: restrict work to owner/repo or owner/* patterns
    --dry-run                    Schedule tasks without invoking agents
`,
  watch: `usage: first-tree github scan watch

  Open the interactive TUI status board and activity feed.
`,
  statusline: `usage: first-tree github scan statusline

  Print the one-line Claude Code statusline summary.
`,
  start: `usage: first-tree github scan start [options]

  Launch the GitHub Scan daemon in the background.

  Options:
    --home <path>                Override runner home
    --profile <name>             Override daemon profile
    --allow-repo <csv>           Required: restrict work to owner/repo or owner/* patterns
    --agent-login <login>        GitHub login to treat as the agent (own-comment guard).
                                 Falls back to GITHUB_SCAN_AGENT_LOGIN, then config-file
                                 \`agent_login\`, then \`gh auth\` identity.
`,
  stop: `usage: first-tree github scan stop [options]

  Stop the background GitHub Scan daemon for the active identity.

  Options:
    --home <path>                Override runner home
    --profile <name>             Override daemon profile
`,
  status: `usage: first-tree github scan status [options]

  Print the current daemon lock and runtime status.

  Options:
    --home <path>                Override runner home
    --allow-repo <csv>           Display an explicit repo filter
`,
  doctor: `usage: first-tree github scan doctor [options]

  Diagnose the local GitHub Scan install and auth/runtime state.

  Options:
    --home <path>                Override runner home
`,
  cleanup: `usage: first-tree github scan cleanup [options]

  Remove stale workspaces and expired claims.

  Options:
    --home <path>                Override runner home
`,
};

type Output = (text: string) => void;

type TsTarget = {
  kind: "ts";
  /** The node:module specifier to `await import()`. */
  specifier:
    | "status-manager"
    | "poll"
    | "watch"
    | "doctor"
    | "status"
    | "cleanup"
    | "start"
    | "stop"
    | "install";
};

type StatuslineTarget = {
  kind: "statusline";
};

type DaemonTarget = {
  kind: "daemon";
  /** `false` for `run`/`daemon`; `true` for `run-once`. */
  once: boolean;
};

type Target = TsTarget | StatuslineTarget | DaemonTarget;

const DISPATCH: Record<string, Target> = {
  install: { kind: "ts", specifier: "install" },

  // Foreground loops — all TS-backed.
  run: { kind: "daemon", once: false },
  daemon: { kind: "daemon", once: false },
  "run-once": { kind: "daemon", once: true },

  // Lifecycle (Phase 6)
  start: { kind: "ts", specifier: "start" },
  stop: { kind: "ts", specifier: "stop" },
  status: { kind: "ts", specifier: "status" },
  doctor: { kind: "ts", specifier: "doctor" },
  cleanup: { kind: "ts", specifier: "cleanup" },
  "poll-inbox": { kind: "ts", specifier: "poll" },

  // One-shot TS commands
  "status-manager": { kind: "ts", specifier: "status-manager" },
  poll: { kind: "ts", specifier: "poll" },
  watch: { kind: "ts", specifier: "watch" },

  // Statusline gets its own tiny dist bundle for sub-30ms cold start.
  statusline: { kind: "statusline" },
};

/**
 * Historical `--backend=...` splitter. The flag is no longer meaningful
 * (Phase 8 dropped the Rust backend), but we still strip any stray
 * occurrence from the argv so existing scripts keep working.
 *
 * Exported for tests.
 */
export function extractBackendFlag(args: readonly string[]): {
  backend: "ts";
  rest: string[];
} {
  const rest: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--backend") {
      // Drop both the flag and its value.
      i += 1;
      continue;
    }
    if (arg?.startsWith("--backend=")) continue;
    rest.push(arg);
  }
  return { backend: "ts", rest };
}

function isHelpInvocation(args: readonly string[]): boolean {
  const first = args[0];
  return first === "--help" || first === "-h";
}

function isVersionInvocation(args: readonly string[]): boolean {
  const first = args[0];
  return first === "--version" || first === "-V" || first === "version";
}

function normalizeArgs(args: readonly string[]): string[] {
  if (args[0] === "help" && args[1]) {
    return [args[1], "--help"];
  }
  return [...args];
}

// oxlint-disable-next-line complexity
export async function runGitHubScan(args: string[], output: Output = console.log): Promise<number> {
  const write = (text: string): void => output(text);

  if (args.length === 0 || (args[0] === "help" && args.length === 1) || isHelpInvocation(args)) {
    write(GITHUB_SCAN_USAGE);
    return 0;
  }

  if (isVersionInvocation(args)) {
    write(GITHUB_SCAN_VERSION);
    return 0;
  }

  const normalizedArgs = normalizeArgs(args);
  const command = normalizedArgs[0];
  const rest = normalizedArgs.slice(1);
  const target = DISPATCH[command];

  if (!target) {
    write(`Unknown github scan command: ${command}`);
    write(GITHUB_SCAN_USAGE);
    return 1;
  }

  const inlineHelp = GITHUB_SCAN_INLINE_HELP[command];
  if (inlineHelp && isHelpInvocation(rest)) {
    write(inlineHelp);
    return 0;
  }

  try {
    switch (target.kind) {
      case "ts": {
        // Lazy-import the TS command so startup stays cheap for workflows
        // that never touch the ported commands.
        if (target.specifier === "status-manager") {
          const mod = await import("./engine/commands/status-manager.js");
          return await mod.runStatusManager(rest);
        }
        if (target.specifier === "poll") {
          const mod = await import("./engine/commands/poll.js");
          return await mod.runPoll(rest);
        }
        if (target.specifier === "watch") {
          const mod = await import("./engine/commands/watch.js");
          return await mod.runWatch(rest);
        }
        if (target.specifier === "doctor") {
          const mod = await import("./engine/commands/doctor.js");
          return await mod.runDoctor(rest);
        }
        if (target.specifier === "status") {
          const mod = await import("./engine/commands/status.js");
          return await mod.runStatus(rest);
        }
        if (target.specifier === "cleanup") {
          const mod = await import("./engine/commands/cleanup.js");
          return await mod.runCleanup(rest);
        }
        if (target.specifier === "start") {
          const mod = await import("./engine/commands/start.js");
          return await mod.runStart(rest);
        }
        if (target.specifier === "stop") {
          const mod = await import("./engine/commands/stop.js");
          return await mod.runStop(rest);
        }
        if (target.specifier === "install") {
          const mod = await import("./engine/commands/install.js");
          return mod.runInstall(rest);
        }
        // Exhaustiveness check.
        const _never: never = target.specifier;
        throw new Error(`unknown ts specifier: ${_never as string}`);
      }
      case "statusline": {
        // Execute the separate `dist/github-scan-statusline.js` bundle via
        // `node`. This keeps cold start under ~30ms: the bundle has zero
        // npm deps and doesn't load the full CLI.
        const bridge = await import("./engine/bridge.js");
        const bundlePath = bridge.resolveStatuslineBundlePath();
        return bridge.spawnInherit(process.execPath, [bundlePath, ...rest]);
      }
      case "daemon": {
        // Strip any stray `--backend=` so existing scripts keep working.
        const { rest: residual } = extractBackendFlag(rest);
        const mod = await import("./engine/daemon/runner-skeleton.js");
        return await mod.runDaemon(residual, { once: target.once });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`first-tree github scan: ${message}\n`);
    return 1;
  }
}
