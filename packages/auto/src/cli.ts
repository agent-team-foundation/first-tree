/**
 * Auto product dispatcher.
 *
 * As of Phase 8 every auto subcommand runs on the TypeScript daemon.
 * `run` / `run-once` / `daemon` all route through `daemon/runner-skeleton.ts`;
 * the historical `auto-runner` Rust binary and the `--backend=` flag
 * have been retired.
 *
 * Lifecycle + diagnostic subcommands (Phase 6): `start`, `stop`,
 * `status`, `doctor`, `cleanup`, `poll-inbox`.
 *
 * Foreground loops (Phase 8): `run` = TS daemon forever; `run-once` =
 * one poll cycle + drain + exit. `daemon` is an alias for `run`.
 *
 * Heavy deps (child_process, ink, react, daemon modules) live in the
 * dynamically-imported command modules so `first-tree auto --help`
 * and `first-tree tree ...` stay lightweight.
 */


export const AUTO_USAGE = `usage: first-tree auto <command>

  Auto is the proposal/inbox agent. It polls explicit GitHub review
  requests and direct mentions, keeps a local inbox under \`~/.first-tree/auto/\`,
  and dispatches work to per-task agent runners.

Primary commands (start here):
  install               Run the first-run setup (creates config.yaml, then
                        starts the daemon; requires \`--allow-repo\`)
  start                 Launch the daemon in the background (launchd on macOS;
                        requires \`--allow-repo\`)
  stop                  Stop the daemon and remove its lock
  status                Print daemon lock + runtime/status.env
  doctor                Diagnose the local install
  watch                 Live TUI: status board + activity feed
  poll                  Poll explicit GitHub review requests and mentions
                        once (no daemon required)

Advanced commands (for agents or debugging):
  run, daemon           Run the broker loop in the foreground.
                        Humans should normally use \`start\` instead; requires
                        \`--allow-repo\`. \`daemon\` is an alias invoked by launchd.
  run-once              Run one poll cycle, wait for drain, exit. Requires
                        \`--allow-repo\`.
  cleanup               Remove stale workspaces + expired claims
                        (only run if \`doctor\` suggests it).

Options:
  --help, -h            Show this help message

Environment:
  AUTO_DIR              Override \`~/.first-tree/auto\` (store root)
  AUTO_HOME             Override \`~/.first-tree/auto/runner\` (daemon private state)

Not shown above (hook/internal entry points — do not invoke directly):
  statusline            Claude Code statusline hook. Called by Claude Code via
                        the separate \`dist/auto-statusline.js\` bundle for
                        sub-30 ms cold start. See the auto skill for wiring.
  status-manager        Internal helper used by auto runners to manage per-
                        session status entries. No direct human/agent use.
  poll-inbox            Legacy alias for \`poll\`. Kept for existing scripts.
`;

const AUTO_INLINE_HELP: Partial<Record<string, string>> = {
  run: `usage: first-tree auto run [options]

  Run the auto daemon in the foreground until stopped.

  Common options:
    --allow-repo <csv>           Required: restrict work to owner/repo or owner/* patterns
    --poll-interval-secs <n>     Seconds between poll cycles
    --task-timeout-secs <n>      Per-task timeout
    --max-parallel <n>           Max concurrent agent tasks
    --search-limit <n>           Max search-derived candidates per cycle
`,
  daemon: `usage: first-tree auto daemon [options]

  Alias for \`first-tree auto run\`. Still requires \`--allow-repo\`.
`,
  "run-once": `usage: first-tree auto run-once [options]

  Run one inbox poll plus one candidate-search cycle, wait for queued
  agent work to drain, then exit.

  Options:
    --allow-repo <csv>           Required: restrict work to owner/repo or owner/* patterns
`,
  watch: `usage: first-tree auto watch

  Open the interactive TUI status board and activity feed.
`,
  statusline: `usage: first-tree auto statusline

  Print the one-line Claude Code statusline summary.
`,
  start: `usage: first-tree auto start [options]

  Launch the auto daemon in the background.

  Options:
    --home <path>                Override runner home
    --profile <name>             Override daemon profile
    --allow-repo <csv>           Required: restrict work to owner/repo or owner/* patterns
`,
  stop: `usage: first-tree auto stop [options]

  Stop the background auto daemon for the active identity.

  Options:
    --home <path>                Override runner home
    --profile <name>             Override daemon profile
`,
  status: `usage: first-tree auto status [options]

  Print the current daemon lock and runtime status.

  Options:
    --home <path>                Override runner home
    --allow-repo <csv>           Display an explicit repo filter
`,
  doctor: `usage: first-tree auto doctor [options]

  Diagnose the local auto install and auth/runtime state.

  Options:
    --home <path>                Override runner home
`,
  cleanup: `usage: first-tree auto cleanup [options]

  Remove stale workspaces and expired claims.

  Options:
    --home <path>                Override runner home
`,
};

type Output = (text: string) => void;

type TsTarget = {
  kind: "ts";
  /** The node:module specifier to `await import()`. */
  specifier: TsSpecifier;
};

type TsSpecifier =
  | "status-manager"
  | "poll"
  | "watch"
  | "doctor"
  | "status"
  | "cleanup"
  | "start"
  | "stop"
  | "install";

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
  return first === "--help" || first === "-h" || first === "help";
}

export async function runAuto(
  args: string[],
  output: Output = console.log,
): Promise<number> {
  const write = (text: string): void => output(text);

  if (args.length === 0 || isHelpInvocation(args)) {
    write(AUTO_USAGE);
    return 0;
  }

  const command = args[0];
  const rest = args.slice(1);
  const target = DISPATCH[command];

  if (!target) {
    write(`Unknown auto command: ${command}`);
    write(AUTO_USAGE);
    return 1;
  }

  const inlineHelp = AUTO_INLINE_HELP[command];
  if (inlineHelp && isHelpInvocation(rest)) {
    write(inlineHelp);
    return 0;
  }

  try {
    switch (target.kind) {
      case "ts":
        return await dispatchTsCommand(target.specifier, rest);
      case "statusline": {
        // Execute the separate `auto-statusline.js` bundle via `node`.
        // This keeps cold start under ~30ms: the bundle has zero npm
        // deps and doesn't load the full first-tree CLI. The bundle
        // resolution differs between dev mode (packages/auto/dist) and
        // bundled npm install (apps/cli/dist sibling); bridge handles
        // both.
        const bridge = await import("./bridge.js");
        const bundlePath = bridge.resolveStatuslineBundlePath();
        return bridge.spawnInherit(process.execPath, [bundlePath, ...rest]);
      }
      case "daemon": {
        // Strip any stray `--backend=` so existing scripts keep working.
        const { rest: residual } = extractBackendFlag(rest);
        const mod = await import("./daemon/runner-skeleton.js");
        return await mod.runDaemon(residual, { once: target.once });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`first-tree auto: ${message}\n`);
    return 1;
  }
}

/**
 * Lazy-import the TS command implementation so startup stays cheap for
 * workflows that never touch the ported commands.
 */
async function dispatchTsCommand(
  specifier: TsSpecifier,
  rest: string[],
): Promise<number> {
  switch (specifier) {
    case "status-manager":
      return (await import("./commands/status-manager.js")).runStatusManager(rest);
    case "poll":
      return (await import("./commands/poll.js")).runPoll(rest);
    case "watch":
      return (await import("./commands/watch.js")).runWatch(rest);
    case "doctor":
      return (await import("./commands/doctor.js")).runDoctor(rest);
    case "status":
      return (await import("./commands/status.js")).runStatus(rest);
    case "cleanup":
      return (await import("./commands/cleanup.js")).runCleanup(rest);
    case "start":
      return (await import("./commands/start.js")).runStart(rest);
    case "stop":
      return (await import("./commands/stop.js")).runStop(rest);
    case "install":
      return (await import("./commands/install.js")).runInstall(rest);
  }
}
