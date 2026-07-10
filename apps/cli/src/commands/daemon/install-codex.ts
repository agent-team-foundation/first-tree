import { probeCapabilities } from "@first-tree/client";
import type { Command } from "commander";
import { fail } from "../../cli/output.js";
import { installCodexRuntime, printResults, runtimeProviderChecks } from "../../core/index.js";
import { isJsonMode, print } from "../../core/output.js";

/**
 * `daemon install-codex` — one-click install of the native Codex engine.
 *
 * First Tree does not bundle the ~225MB native `codex` binary by default; the
 * runtime resolves an external `codex` from PATH, known install locations, or
 * the macOS ChatGPT/Codex desktop app. When none exists, the codex capability
 * probes as `missing`. This command is the remediation: it runs
 * `npm install -g @openai/codex` through the same tracked-subprocess path the
 * CLI self-update uses, then re-probes so the freshly installed binary is
 * reflected in the capability snapshot.
 *
 * It is purely local (no First Tree credentials needed). The daemon exposes
 * the same routine to the web UI via the reverse-command channel so an
 * operator can trigger it from "Codex runtime missing → Install".
 */
export function registerDaemonInstallCodexCommand(daemon: Command): void {
  daemon
    .command("install-codex")
    .description("Install the native Codex runtime engine on this machine (npm install -g @openai/codex)")
    .option("--spec <spec>", "npm dist-tag or exact version to install", "latest")
    .option("--json", "Emit the post-install capability snapshot as a machine-readable JSON envelope")
    .action(async (options: { spec?: string; json?: boolean }) => {
      const wantJson = options.json === true || isJsonMode();
      const spec = options.spec ?? "latest";

      if (!wantJson) print.line(`\n  Installing native Codex runtime (@openai/codex@${spec})...\n\n`);
      const result = await installCodexRuntime(spec);

      if (!result.ok) {
        if (wantJson) fail("CODEX_INSTALL_FAILED", result.reason, 1);
        print.status("✖", `Codex install failed: ${result.reason}`);
        if (result.retryable) print.line("  This looks transient — retry in a moment.\n\n");
        process.exitCode = 1;
        return;
      }

      if (!wantJson) {
        print.status("✓", `Installed @openai/codex${result.installedVersion ? `@${result.installedVersion}` : ""}`);
        print.line("\n  Re-probing codex capability...\n\n");
      }

      // Re-probe (install-only) so the new PATH binary flips the codex row from
      // `missing` to `ok` (installed).
      const capabilities = await probeCapabilities();
      if (wantJson) {
        print.result(capabilities);
        return;
      }
      printResults(runtimeProviderChecks(capabilities));
      print.line(
        "  codex now reports `ok` (installed). Authentication is no longer probed — if a session\n" +
          "  fails needing login, sign in from that chat (or run `codex login` on this machine).\n\n",
      );
    });
}
