/**
 * Breeze product dispatcher.
 *
 * Phase 1 bridge: routes `first-tree breeze <cmd>` to the existing Rust
 * binary (`breeze-runner`) and bundled bash scripts under
 * `assets/breeze/bin/`. No argument mangling, no re-interpretation — user
 * args pass through verbatim and the child's exit code is propagated.
 *
 * Heavy deps (child_process, fs path resolution) live in `./bridge.js` and
 * are only imported at call time so the top-level umbrella CLI stays
 * lightweight for agents that never touch breeze.
 */

export const BREEZE_USAGE = `usage: first-tree breeze <command>

  Breeze is the proposal/inbox agent. Phase 1 of the TypeScript rewrite
  simply dispatches into the existing Rust runner and bundled bash
  scripts; behaviour and flags are unchanged.

Commands that run the Rust daemon (\`breeze-runner\`):
  run                   Run the broker loop forever
  run-once              Run a single broker iteration and exit
  start                 Start the broker in the background
  stop                  Stop a background broker
  status                Print broker / inbox status
  poll                  Poll the inbox once
  doctor                Diagnose the local install
  cleanup               Clean up stale state

Commands that run bundled bash helpers:
  watch                 Tail the inbox and notify on new items
  status-manager        Manage per-session status entries
  statusline            Claude Code statusline wrapper

Installer:
  install               Run the breeze setup script

Options:
  --help, -h            Show this help message

Environment:
  BREEZE_RUNNER_BIN     Override the path to the \`breeze-runner\` binary
`;

type Output = (text: string) => void;

// Keep in sync with the breeze-runner subcommand set in
// first-tree-breeze/breeze-runner/src/lib.rs and with the bash scripts under
// assets/breeze/bin/. The dispatcher table below is the single source of
// truth for phase-1 routing.
type RunnerTarget = {
  kind: "runner";
  /** Subcommand name passed to `breeze-runner`. */
  subcommand: string;
};

type ScriptTarget = {
  kind: "script";
  /** File name inside assets/breeze/bin/. */
  script: string;
};

type SetupTarget = {
  kind: "setup";
};

type TsTarget = {
  kind: "ts";
  /** The node:module specifier to `await import()`. */
  specifier: "status-manager";
};

type Target = RunnerTarget | ScriptTarget | SetupTarget | TsTarget;

const DISPATCH: Record<string, Target> = {
  install: { kind: "setup" },

  // breeze-runner subcommands
  run: { kind: "runner", subcommand: "run" },
  "run-once": { kind: "runner", subcommand: "run-once" },
  start: { kind: "runner", subcommand: "start" },
  stop: { kind: "runner", subcommand: "stop" },
  status: { kind: "runner", subcommand: "status" },
  poll: { kind: "runner", subcommand: "poll" },
  doctor: { kind: "runner", subcommand: "doctor" },
  cleanup: { kind: "runner", subcommand: "cleanup" },

  // bundled bash scripts
  watch: { kind: "script", script: "breeze-watch" },
  statusline: { kind: "script", script: "breeze-statusline-wrapper" },

  // TS ports (Phase 2a onward)
  "status-manager": { kind: "ts", specifier: "status-manager" },
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
      case "script": {
        const bridge = await import("./bridge.js");
        const scriptPath = bridge.resolveBundledBreezeScript(target.script);
        return bridge.spawnInherit(scriptPath, rest);
      }
      case "setup": {
        const bridge = await import("./bridge.js");
        const setupPath = bridge.resolveBreezeSetupScript();
        return bridge.spawnInherit("bash", [setupPath, ...rest]);
      }
      case "ts": {
        // Lazy-import the TS command so startup stays cheap for
        // workflows that never touch the ported commands.
        if (target.specifier === "status-manager") {
          const mod = await import("./commands/status-manager.js");
          return await mod.runStatusManager(rest);
        }
        // Exhaustiveness check.
        const _never: never = target.specifier;
        throw new Error(`unknown ts specifier: ${_never as string}`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`first-tree breeze: ${message}\n`);
    return 1;
  }
}
