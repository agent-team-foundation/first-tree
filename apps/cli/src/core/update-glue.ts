import type { ExecuteUpdateFn, UpdatePromptFn } from "@first-tree/client";
import { confirm } from "@inquirer/prompts";
import * as semver from "semver";
import { print } from "./output.js";
import { detectInstallMode, installGlobalSpec } from "./update.js";
import { isLoopGuarded, recordUpdateAttempt } from "./update-state.js";

/** Reserved exit code that means "clean self-restart, service manager please bring me back". */
export const SELF_RESTART_EXIT_CODE = 75;

/** Interactive update prompt. Defaults to N on timeout. */
export const promptUpdate: UpdatePromptFn = async ({ currentVersion, targetVersion, timeoutSeconds }) => {
  // Phrasing matches the post-poller install path: we install the exact
  // version the server advertised, not whatever `@latest` happens to point
  // at. "Server recommends" (rather than "bundled with") because the version
  // now comes from the server's npm-registry poll for the configured
  // channel, not from the server image build.
  const message = `A newer First Tree Hub client is available.\n  You: ${currentVersion}\n  Server recommends: ${targetVersion}\n  Will install: ${targetVersion}\n  Updating will restart the client and briefly interrupt any active sessions.\n  Update now?`;
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
 * `client start`, `connect <token> --no-start`, CI without a supervisor).
 * Exiting in that mode would leave the client offline until an operator
 * noticed — so the callback instead prints a restart hint, returns
 * `{ installed: true }`, and the UpdateManager stops retrying until the
 * operator restarts manually.
 */
export function createExecuteUpdate({ managed }: { managed: boolean }): ExecuteUpdateFn {
  return async ({ currentVersion, targetVersion }) => {
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

    // Cross-restart loop guard: if a previous attempt installed this exact
    // target version but the on-disk binary never advanced (npm latest
    // resolved to the same version we already had, dist-tag silently
    // re-pointed, etc.), running it again would re-trigger the same
    // exit(75) → restart → drift → install loop until systemd's
    // StartLimit kills the service. Refuse instead, and surface the
    // reason so the operator knows what to do (run `connect <token>`
    // again, or `npm i -g …@latest` manually). Returning
    // `{ installed: true }` is the right shape here — it puts the
    // UpdateManager into `pendingRestart=true`, blocking further attempts
    // until the operator restarts the process.
    //
    // Note: we deliberately do NOT call `recordUpdateAttempt` on this
    // branch. The on-disk `blocked` record written by the previous
    // process is exactly the state we want to surface to admins; writing
    // a fresh record here would just push the timestamp forward without
    // adding information. "Freeze, don't refresh" is the intended
    // semantics — if you change it, also reconsider how the admin
    // dashboard interprets `at` (currently: "when did this client first
    // get stuck on $target").
    if (isLoopGuarded(targetVersion)) {
      print.line(
        `  [update] Refusing to retry ${targetVersion} — a previous attempt completed without\n` +
          "           advancing the on-disk version. The most likely cause is npm's `latest`\n" +
          "           dist-tag resolving to the same version this client is already running.\n" +
          "           Operator action: manually run `npm install -g @agent-team-foundation/first-tree-hub@latest`,\n" +
          "           then restart the service.\n",
      );
      return { installed: true };
    }

    // Auto-update installs the *exact* version the server advertised in
    // `server:welcome.serverCommandVersion`. Using `@latest` here would
    // mis-resolve once the server starts advertising alpha builds (alpha
    // lives on a different dist-tag), and even on the stable track it could
    // race to a different version than the one drift-check approved. The
    // server is the authoritative source of "what should this client run".
    print.line(`  [update] Running \`npm install -g @agent-team-foundation/first-tree-hub@${targetVersion}\`...\n`);
    const result = await installGlobalSpec(targetVersion);
    if (!result.ok) {
      print.line(`  [update] Install failed: ${result.reason}\n`);
      recordUpdateAttempt({
        result: "failed",
        target: targetVersion,
        currentBefore: currentVersion,
        installedVersion: null,
        reason: result.reason,
        at: new Date().toISOString(),
      });
      return { installed: false };
    }

    // Loop detection: npm reported success, but did it actually install
    // the target? Comparing `installed` against `targetVersion` (rather
    // than `currentVersion`) is deliberate — the failure we're guarding
    // against is "npm resolved our spec to something other than what we
    // asked for" (stale dist-tag, channel misconfig, registry mirror
    // lag). If `installed < targetVersion`, exit(75) restarts into a
    // binary still older than what the server is advertising and the
    // drift check on the next welcome triggers another install: that's
    // the loop. Using `lt(installed, target)` (not
    // `lte(installed, current)`) also means an intentional server-driven
    // downgrade — should we ever support one — wouldn't be misflagged
    // as a no-advance loop, because there'd be no drift left to trigger
    // a second attempt. semver.valid guards protect against
    // `result.installedVersion === null` (npm stdout didn't parse
    // cleanly); in that case we proceed normally because we can't
    // disprove a successful install.
    const installed = result.installedVersion;
    if (installed && semver.valid(installed) && semver.valid(targetVersion) && semver.lt(installed, targetVersion)) {
      const reason = `npm reported install of ${installed}, but the server-advertised target was ${targetVersion} (running ${currentVersion})`;
      print.line(`  [update] WARNING: ${reason}\n`);
      print.line("  [update] Skipping restart to avoid an exit-75 → reboot loop. Loop guard armed.\n");
      recordUpdateAttempt({
        result: "blocked",
        target: targetVersion,
        currentBefore: currentVersion,
        installedVersion: installed,
        reason,
        at: new Date().toISOString(),
      });
      // Treat as `installed: true` so the UpdateManager sets
      // pendingRestart and stops retrying this welcome session. No
      // exit(75) — the supervisor MUST NOT relaunch us into the same
      // broken state.
      return { installed: true };
    }

    const installedLabel = installed ?? targetVersion;
    recordUpdateAttempt({
      result: "ok",
      target: targetVersion,
      currentBefore: currentVersion,
      installedVersion: installed,
      reason: null,
      at: new Date().toISOString(),
    });
    if (managed) {
      print.line(`  [update] Installed ${installedLabel}. Restarting (exit ${SELF_RESTART_EXIT_CODE}).\n`);
      process.exit(SELF_RESTART_EXIT_CODE);
    }
    print.line(
      `  [update] Installed ${installedLabel}. Restart the client manually (Ctrl+C then \`first-tree-hub daemon start\`) to pick up the new version.\n`,
    );
    return { installed: true };
  };
}
