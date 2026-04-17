/**
 * Breeze product dispatcher.
 *
 * Phase 3a adds the `daemon` subcommand with a `--backend=ts|rust` flag.
 * The `rust` backend (default) continues to route through `bridge.ts`
 * into the `breeze-runner` binary — identical to the Phase 2b behaviour,
 * just under a new command name. The `ts` backend lazy-imports the
 * Phase 3a runner skeleton (`./daemon/runner-skeleton.ts`).
 *
 * Phase 2b ports: `poll`, `watch`, `statusline` are TS commands. The
 * daemon-mode commands (`run`, `run-once`, `start`, `stop`, `status`,
 * `cleanup`, `doctor`) still bridge to the Rust binary while Phase 3b/3c
 * (http, broker, bus) are implemented.
 *
 * Heavy deps (child_process, ink, react, daemon modules) live in the
 * dynamically-imported command modules so `first-tree breeze --help`
 * and `first-tree tree ...` stay lightweight.
 */

import { join } from "node:path";

export const BREEZE_USAGE = `usage: first-tree breeze <command>

  Breeze is the proposal/inbox agent.

Commands that run the Rust daemon (\`breeze-runner\`):
  run                   Run the broker loop forever
  run-once              Run a single broker iteration and exit

Commands ported to TypeScript (run against \`~/.breeze\`):
  start                 Launch the TS daemon in the background (launchd on macOS)
  stop                  Stop the TS daemon and remove its lock
  status                Print daemon lock + runtime/status.env
  doctor                Diagnose the local install
  cleanup               Remove stale workspaces + expired claims
  poll-inbox            Alias for \`poll\` (one-shot notification fetch)

Daemon (phase 3, experimental):
  daemon [--backend=ts|rust]
                        Run the breeze daemon in the foreground.
                        \`--backend=rust\` (default) is equivalent to \`run\`.
                        \`--backend=ts\` launches the in-progress TS port.

TypeScript commands (no daemon required):
  poll                  Poll GitHub notifications once and update the inbox
  watch                 Live TUI: status board + activity feed
  statusline            Claude Code statusline hook (single-line output)
  status-manager        Manage per-session status entries

Installer:
  install               Run the breeze setup script

Options:
  --help, -h            Show this help message

Environment:
  BREEZE_RUNNER_BIN     Override the path to the \`breeze-runner\` binary
  BREEZE_DIR            Override \`~/.breeze\` (store root)
`;

type Output = (text: string) => void;

// Keep in sync with the breeze-runner subcommand set in
// first-tree-breeze/breeze-runner/src/lib.rs. The dispatcher table below
// is the single source of truth for routing.
type RunnerTarget = {
  kind: "runner";
  /** Subcommand name passed to `breeze-runner`. */
  subcommand: string;
};

type SetupTarget = {
  kind: "setup";
};

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
    | "stop";
};

type StatuslineTarget = {
  kind: "statusline";
};

type DaemonTarget = {
  kind: "daemon";
};

type Target =
  | RunnerTarget
  | SetupTarget
  | TsTarget
  | StatuslineTarget
  | DaemonTarget;

const DISPATCH: Record<string, Target> = {
  install: { kind: "setup" },

  // breeze-runner subcommands — `run` / `run-once` still bridge to the
  // Rust binary while Phase 3-7 overlap lands; the rest are TS.
  run: { kind: "runner", subcommand: "run" },
  "run-once": { kind: "runner", subcommand: "run-once" },
  start: { kind: "ts", specifier: "start" },
  stop: { kind: "ts", specifier: "stop" },
  status: { kind: "ts", specifier: "status" },
  doctor: { kind: "ts", specifier: "doctor" },
  cleanup: { kind: "ts", specifier: "cleanup" },
  "poll-inbox": { kind: "ts", specifier: "poll" },

  // TS ports
  "status-manager": { kind: "ts", specifier: "status-manager" },
  poll: { kind: "ts", specifier: "poll" },
  watch: { kind: "ts", specifier: "watch" },

  // Statusline gets its own tiny dist bundle for sub-30ms cold start.
  statusline: { kind: "statusline" },

  // Phase 3a daemon (backend-switched).
  daemon: { kind: "daemon" },
};

/**
 * Split `--backend=...` out of the argv. Supports both
 * `--backend=ts` and `--backend ts` forms. Unknown values fall through
 * to the default (`rust`) and leave the flag in the residual argv so
 * the chosen backend can reject/surface it.
 *
 * Exported for tests.
 */
export function extractBackendFlag(args: readonly string[]): {
  backend: "ts" | "rust";
  rest: string[];
} {
  const rest: string[] = [];
  let backend: "ts" | "rust" = "rust";
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--backend") {
      const value = args[i + 1];
      if (value === "ts" || value === "rust") {
        backend = value;
        i += 1;
        continue;
      }
      // Unknown/missing value: keep the flag in `rest` so the backend
      // complains with a full error message.
      rest.push(arg);
      continue;
    }
    if (arg?.startsWith("--backend=")) {
      const value = arg.slice("--backend=".length);
      if (value === "ts" || value === "rust") {
        backend = value;
        continue;
      }
      rest.push(arg);
      continue;
    }
    rest.push(arg);
  }
  return { backend, rest };
}

export async function runBreeze(
  args: string[],
  output: Output = console.log,
): Promise<number> {
  const write = (text: string): void => output(text);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
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

  try {
    switch (target.kind) {
      case "runner": {
        const bridge = await import("./bridge.js");
        const runner = bridge.resolveBreezeRunner();
        return bridge.spawnInherit(runner.path, [target.subcommand, ...rest]);
      }
      case "setup": {
        const bridge = await import("./bridge.js");
        const setupPath = bridge.resolveBreezeSetupScript();
        return bridge.spawnInherit("bash", [setupPath, ...rest]);
      }
      case "ts": {
        // Lazy-import the TS command so startup stays cheap for workflows
        // that never touch the ported commands.
        if (target.specifier === "status-manager") {
          const mod = await import("./commands/status-manager.js");
          return await mod.runStatusManager(rest);
        }
        if (target.specifier === "poll") {
          const mod = await import("./commands/poll.js");
          return await mod.runPoll(rest);
        }
        if (target.specifier === "watch") {
          const mod = await import("./commands/watch.js");
          return await mod.runWatch(rest);
        }
        if (target.specifier === "doctor") {
          const mod = await import("./commands/doctor.js");
          return await mod.runDoctor(rest);
        }
        if (target.specifier === "status") {
          const mod = await import("./commands/status.js");
          return await mod.runStatus(rest);
        }
        if (target.specifier === "cleanup") {
          const mod = await import("./commands/cleanup.js");
          return await mod.runCleanup(rest);
        }
        if (target.specifier === "start") {
          const mod = await import("./commands/start.js");
          return await mod.runStart(rest);
        }
        if (target.specifier === "stop") {
          const mod = await import("./commands/stop.js");
          return await mod.runStop(rest);
        }
        // Exhaustiveness check.
        const _never: never = target.specifier;
        throw new Error(`unknown ts specifier: ${_never as string}`);
      }
      case "statusline": {
        // Execute the separate `dist/breeze-statusline.js` bundle via
        // `node`. This keeps cold start under ~30ms: the bundle has zero
        // npm deps and doesn't load the full first-tree CLI.
        const bridge = await import("./bridge.js");
        const packageRoot = bridge.resolveFirstTreePackageRoot();
        const bundlePath = join(packageRoot, "dist", "breeze-statusline.js");
        return bridge.spawnInherit(process.execPath, [bundlePath, ...rest]);
      }
      case "daemon": {
        const { backend, rest: residual } = extractBackendFlag(rest);
        if (backend === "ts") {
          // Phase 3a: TS daemon (read path only). Lazy-imported so the
          // daemon modules (poller, identity, yaml config) never touch
          // cold-start latency for non-daemon commands.
          const mod = await import("./daemon/runner-skeleton.js");
          return await mod.runDaemon(residual);
        }
        // Default: route through the Rust runner's `run` subcommand for
        // parity with Phase 2b. Forwards flag order verbatim.
        const bridge = await import("./bridge.js");
        const runner = bridge.resolveBreezeRunner();
        return bridge.spawnInherit(runner.path, ["run", ...residual]);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`first-tree breeze: ${message}\n`);
    return 1;
  }
}
