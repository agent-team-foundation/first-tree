/**
 * Breeze product dispatcher.
 *
 * Phase 2b: `poll`, `watch`, and `statusline` are TS ports. The daemon
 * commands (`run`, `run-once`, `start`, `stop`, `status`, `cleanup`,
 * `doctor`) and the setup/installer still bridge to the Rust binary +
 * `first-tree-breeze/setup` — those are Phase 3.
 *
 * Heavy deps (child_process, ink, react) live in the dynamically-imported
 * command modules so `first-tree breeze --help` and
 * `first-tree tree ...` stay lightweight.
 */

import { join } from "node:path";

export const BREEZE_USAGE = `usage: first-tree breeze <command>

  Breeze is the proposal/inbox agent.

Commands that run the Rust daemon (\`breeze-runner\`):
  run                   Run the broker loop forever
  run-once              Run a single broker iteration and exit
  start                 Start the broker in the background
  stop                  Stop a background broker
  status                Print broker / inbox status
  doctor                Diagnose the local install
  cleanup               Clean up stale state

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
  specifier: "status-manager" | "poll" | "watch";
};

type StatuslineTarget = {
  kind: "statusline";
};

type Target = RunnerTarget | SetupTarget | TsTarget | StatuslineTarget;

const DISPATCH: Record<string, Target> = {
  install: { kind: "setup" },

  // breeze-runner subcommands (Phase 3 ports)
  run: { kind: "runner", subcommand: "run" },
  "run-once": { kind: "runner", subcommand: "run-once" },
  start: { kind: "runner", subcommand: "start" },
  stop: { kind: "runner", subcommand: "stop" },
  status: { kind: "runner", subcommand: "status" },
  doctor: { kind: "runner", subcommand: "doctor" },
  cleanup: { kind: "runner", subcommand: "cleanup" },

  // TS ports
  "status-manager": { kind: "ts", specifier: "status-manager" },
  poll: { kind: "ts", specifier: "poll" },
  watch: { kind: "ts", specifier: "watch" },

  // Statusline gets its own tiny dist bundle for sub-30ms cold start.
  statusline: { kind: "statusline" },
};

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
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`first-tree breeze: ${message}\n`);
    return 1;
  }
}
