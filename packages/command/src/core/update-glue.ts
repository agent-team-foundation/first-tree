import type { ExecuteUpdateFn, UpdatePromptFn } from "@first-tree-hub/client";
import { confirm } from "@inquirer/prompts";
import { print } from "./output.js";
import { detectInstallMode, installGlobalLatest } from "./update.js";

/** Reserved exit code that means "clean self-restart, service manager please bring me back". */
export const SELF_RESTART_EXIT_CODE = 75;

/** Interactive update prompt. Defaults to N on timeout. */
export const promptUpdate: UpdatePromptFn = async ({ currentVersion, targetVersion, timeoutSeconds }) => {
  const message = `A newer First Tree Hub client is available.\n  You: ${currentVersion}\n  Server bundled with: ${targetVersion}\n  Will install: latest on npm (>= ${targetVersion})\n  Updating will restart the client and briefly interrupt any active sessions.\n  Update now?`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    try {
      return await confirm({ message, default: false }, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // AbortError on timeout, or stdin-not-a-TTY
    return false;
  }
};

/**
 * Update prompt that always declines. Wired in when the operator passes
 * `--no-interactive` — the UpdateManager will log the drift and move on
 * instead of blocking on a TTY confirm.
 */
export const declineUpdate: UpdatePromptFn = async () => false;

/**
 * Build the command-layer `executeUpdate` callback.
 *
 * `managed=true` means a process supervisor (launchd / systemd / Docker
 * `restart`) is expected to relaunch us after `process.exit` — the callback
 * installs the new bits and exits with `SELF_RESTART_EXIT_CODE` so the
 * relaunch picks up the new binary.
 *
 * `managed=false` means the process is running standalone (e.g. manual
 * `client start`, `client connect --no-service`, CI without a supervisor).
 * Exiting in that mode would leave the client offline until an operator
 * noticed — so the callback instead prints a restart hint, returns
 * `{ installed: true }`, and the UpdateManager stops retrying until the
 * operator restarts manually.
 */
export function createExecuteUpdate({ managed }: { managed: boolean }): ExecuteUpdateFn {
  return async () => {
    const mode = detectInstallMode();
    if (mode === "source") {
      print.line("  [update] Running from source checkout — self-update skipped. Use `git pull` instead.\n");
      return { installed: false };
    }
    if (mode === "npx") {
      print.line(
        "  [update] Cannot self-update — not launched from a global npm install.\n  Run `npm i -g @agent-team-foundation/first-tree-hub` manually.\n",
      );
      return { installed: false };
    }

    print.line("  [update] Running `npm install -g @agent-team-foundation/first-tree-hub@latest`...\n");
    const result = await installGlobalLatest();
    if (!result.ok) {
      print.line(`  [update] Install failed: ${result.reason}\n`);
      return { installed: false };
    }

    const installed = result.installedVersion ?? "latest";
    if (managed) {
      print.line(`  [update] Installed ${installed}. Restarting (exit ${SELF_RESTART_EXIT_CODE}).\n`);
      process.exit(SELF_RESTART_EXIT_CODE);
    }
    print.line(
      `  [update] Installed ${installed}. Restart the client manually (Ctrl+C then \`first-tree-hub client start\`) to pick up the new version.\n`,
    );
    return { installed: true };
  };
}
