import { DEFAULT_HOME_DIR, type HomeMigrationResult, migrateLegacyHome } from "@first-tree/shared/config";
import { print } from "./output.js";
import { getClientServiceStatus, installClientService } from "./service-install.js";

/**
 * Run the one-shot legacy home migration at CLI startup and, if it succeeds,
 * re-register the background service so launchd/systemd pick up the new
 * `StandardOutPath` / `StandardErrorPath` / `ExecStart` log paths (those are
 * baked into the plist/unit file at install time — when we populate the new
 * home, those paths would otherwise still point at the old location).
 *
 * Copy-only semantics: the legacy `~/.first-tree-hub/` tree is preserved
 * as a safety net. The user can inspect/fall-back to it, and can delete it
 * manually once they've confirmed the new layout is healthy.
 *
 * Contract:
 *   - Synchronous and cheap when there's nothing to do (most runs — the
 *     steady state is "new dir populated", which short-circuits the copy).
 *   - Never throws — migration failures and service re-register failures
 *     both fall through to a stderr warning so the CLI command still runs.
 *   - Idempotent — safe to call on every CLI invocation.
 *   - Skips service re-register when we are already running AS the service
 *     (launchd/systemd invoke the CLI with `--no-interactive`), because the
 *     re-register would bootout our own process mid-execution.
 */
export function runHomeMigration(): void {
  const result: HomeMigrationResult = migrateLegacyHome({
    newHome: DEFAULT_HOME_DIR,
    envOverride: process.env.FIRST_TREE_HOME ?? null,
  });

  if (!result.migrated) {
    // Only surface reasons that warrant user attention. `no-legacy-dir`,
    // `custom-home`, and `new-dir-populated` are all steady states after
    // first successful migration (or for fresh installs / custom homes) —
    // staying silent avoids noise on every CLI call.
    if (result.reason === "failed") {
      print.line(
        `[first-tree-hub] WARNING: failed to auto-migrate legacy home ${result.from} → ${result.to}: ${result.error ?? "unknown error"}\n` +
          `  Resolve manually: cp -R "${result.from}" "${result.to}"\n`,
      );
    }
    return;
  }

  print.line(
    `[first-tree-hub] Copied client home to new layout: ${result.from} → ${result.to}\n` +
      `  (Legacy directory preserved as a backup — delete it manually once you've verified the new location works.)\n`,
  );

  // Re-registering the service means launchctl bootout + bootstrap on macOS —
  // that would kill our own process if we're the service. Detect via the
  // flag passed by the installed unit (see `renderPlist` / `renderSystemdUnit`
  // in service-install.ts).
  const runningAsService = process.argv.includes("--no-interactive");
  if (runningAsService) {
    print.line(
      `[first-tree-hub] Note: running as background service — skipped auto re-register to avoid self-termination.\n` +
        `  Service paths will refresh on the next \`first-tree-hub login <token>\`.\n`,
    );
    return;
  }

  const status = getClientServiceStatus();
  if (status.platform === "unsupported" || status.state === "not-installed") {
    return;
  }

  try {
    installClientService();
    print.line(`[first-tree-hub] Re-registered background service with new home paths.\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    print.line(
      `[first-tree-hub] WARNING: home migration succeeded but re-registering the background service failed: ${msg}\n` +
        `  Re-run \`first-tree-hub login <token>\` to refresh service paths.\n`,
    );
  }
}
