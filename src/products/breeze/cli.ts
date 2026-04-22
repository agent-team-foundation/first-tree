/**
 * Breeze product dispatcher.
 *
 * As of Phase 8 every breeze subcommand runs on the TypeScript daemon.
 * `run` / `run-once` / `daemon` all route through `daemon/runner-skeleton.ts`;
 * the historical `breeze-runner` Rust binary and the `--backend=` flag
 * have been retired.
 *
 * Lifecycle + diagnostic subcommands (Phase 6): `start`, `stop`,
 * `status`, `doctor`, `cleanup`, `poll-inbox`.
 *
 * Foreground loops (Phase 8): `run` = TS daemon forever; `run-once` =
 * one poll cycle + drain + exit. `daemon` is an alias for `run`.
 *
 * Heavy deps (child_process, ink, react, daemon modules) live in the
 * dynamically-imported command modules so `first-tree breeze --help`
 * and `first-tree tree ...` stay lightweight.
 */

import { join } from "node:path";

export const BREEZE_USAGE = `usage: first-tree breeze <command>

  Breeze is the proposal/inbox agent. It polls GitHub notifications,
  keeps a local inbox under \`~/.breeze/\`, and dispatches work to
  per-task agent runners.

Primary commands (start here):
  install               Run the first-run setup (creates config.yaml, then
                        starts the daemon; requires \`--allow-repo\`)
  start                 Launch the daemon in the background (launchd on macOS;
                        requires \`--allow-repo\`)
  stop                  Stop the daemon and remove its lock
  status                Print daemon lock + runtime/status.env
  doctor                Diagnose the local install
  watch                 Live TUI: status board + activity feed
  poll                  Poll GitHub notifications once (no daemon required)

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
  BREEZE_DIR            Override \`~/.breeze\` (store root)
  BREEZE_HOME           Override \`~/.breeze/runner\` (daemon private state)

Not shown above (hook/internal entry points — do not invoke directly):
  statusline            Claude Code statusline hook. Called by Claude Code via
                        the separate \`dist/breeze-statusline.js\` bundle for
                        sub-30 ms cold start. See the breeze skill for wiring.
  status-manager        Internal helper used by breeze runners to manage per-
                        session status entries. No direct human/agent use.
  poll-inbox            Legacy alias for \`poll\`. Kept for existing scripts.
`;

const BREEZE_INLINE_HELP: Partial<Record<string, string>> = {
  run: `usage: first-tree breeze run [options]

  Run the Breeze daemon in the foreground until stopped.

  Common options:
    --allow-repo <csv>           Required: restrict work to owner/repo or owner/* patterns
    --poll-interval-secs <n>     Seconds between poll cycles
    --task-timeout-secs <n>      Per-task timeout
    --max-parallel <n>           Max concurrent agent tasks
    --search-limit <n>           Max search-derived candidates per cycle
`,
  daemon: `usage: first-tree breeze daemon [options]

  Alias for \`first-tree breeze run\`. Still requires \`--allow-repo\`.
`,
  "run-once": `usage: first-tree breeze run-once [options]

  Run one inbox poll plus one candidate-search cycle, wait for queued
  agent work to drain, then exit.

  Options:
    --allow-repo <csv>           Required: restrict work to owner/repo or owner/* patterns
`,
  watch: `usage: first-tree breeze watch

  Open the interactive TUI status board and activity feed.
`,
  statusline: `usage: first-tree breeze statusline

  Print the one-line Claude Code statusline summary.
`,
  start: `usage: first-tree breeze start [options]

  Launch the Breeze daemon in the background.

  Options:
    --home <path>                Override runner home
    --profile <name>             Override daemon profile
    --allow-repo <csv>           Required: restrict work to owner/repo or owner/* patterns
`,
  stop: `usage: first-tree breeze stop [options]

  Stop the background Breeze daemon for the active identity.

  Options:
    --home <path>                Override runner home
    --profile <name>             Override daemon profile
`,
  status: `usage: first-tree breeze status [options]

  Print the current daemon lock and runtime status.

  Options:
    --home <path>                Override runner home
    --allow-repo <csv>           Display an explicit repo filter
`,
  doctor: `usage: first-tree breeze doctor [options]

  Diagnose the local Breeze install and auth/runtime state.

  Options:
    --home <path>                Override runner home
`,
  cleanup: `usage: first-tree breeze cleanup [options]

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
  return first === "--help" || first === "-h" || first === "help";
}

export async function runBreeze(
  args: string[],
  output: Output = console.log,
): Promise<number> {
  const write = (text: string): void => output(text);

  if (args.length === 0 || isHelpInvocation(args)) {
    write(BREEZE_USAGE);
    return 0;
  }

  const command = args[0];
  const rest = args.slice(1);
  const target = DISPATCH[command];

  if (!target) {
    write(`Unknown breeze command: ${command}`);
    write(BREEZE_USAGE);
    return 1;
  }

  const inlineHelp = BREEZE_INLINE_HELP[command];
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
        // Execute the separate `dist/breeze-statusline.js` bundle via
        // `node`. This keeps cold start under ~30ms: the bundle has zero
        // npm deps and doesn't load the full first-tree CLI.
        const bridge = await import("./engine/bridge.js");
        const packageRoot = bridge.resolveFirstTreePackageRoot();
        const bundlePath = join(packageRoot, "dist", "breeze-statusline.js");
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
    process.stderr.write(`first-tree breeze: ${message}\n`);
    return 1;
  }
}
