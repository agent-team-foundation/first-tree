import { probeCapabilities } from "@first-tree/client";
import type { Command } from "commander";
import { fail } from "../../cli/output.js";
import { installClaudeRuntime, printResults, runtimeProviderChecks } from "../../core/index.js";
import { isJsonMode, print } from "../../core/output.js";

/**
 * `daemon install-claude` — one-click install of the native Claude Code engine.
 *
 * First Tree does not bundle the ~210MB native `claude` binary by default; the
 * runtime resolves a system `claude` (env override / PATH / well-known install
 * dirs). When none exists, the claude-code capability probes as `missing`. This
 * command is the remediation: it runs `npm install -g @anthropic-ai/claude-code`
 * through the same tracked-subprocess path the CLI self-update uses, then
 * re-probes so the freshly installed binary is reflected in the capability
 * snapshot.
 *
 * It is purely local (no First Tree credentials needed). The daemon exposes
 * the same routine to the web UI via the reverse-command channel so an
 * operator can trigger it from "Claude runtime missing → Install".
 */
export function registerDaemonInstallClaudeCommand(daemon: Command): void {
  daemon
    .command("install-claude")
    .description(
      "Install the native Claude Code runtime engine on this machine (npm install -g @anthropic-ai/claude-code)",
    )
    .option("--spec <spec>", "npm dist-tag or exact version to install", "latest")
    .option("--json", "Emit the post-install capability snapshot as a machine-readable JSON envelope")
    .action(async (options: { spec?: string; json?: boolean }) => {
      const wantJson = options.json === true || isJsonMode();
      const spec = options.spec ?? "latest";

      if (!wantJson) print.line(`\n  Installing native Claude Code runtime (@anthropic-ai/claude-code@${spec})...\n\n`);
      const result = await installClaudeRuntime(spec);

      if (!result.ok) {
        if (wantJson) fail("CLAUDE_INSTALL_FAILED", result.reason, 1);
        print.status("✖", `Claude install failed: ${result.reason}`);
        if (result.retryable) print.line("  This looks transient — retry in a moment.\n\n");
        process.exitCode = 1;
        return;
      }

      if (!wantJson) {
        print.status(
          "✓",
          `Installed @anthropic-ai/claude-code${result.installedVersion ? `@${result.installedVersion}` : ""}`,
        );
        print.line("\n  Re-probing claude-code capability...\n\n");
      }

      // Re-probe so the new PATH binary is launch-verified and the claude-code
      // row flips from `missing` toward `ok`/`unauthenticated`.
      const capabilities = await probeCapabilities();
      if (wantJson) {
        print.result(capabilities);
        return;
      }
      printResults(runtimeProviderChecks(capabilities));
      print.line("  If claude-code now reports `unauthenticated`, run runtime auth (claude auth login) to finish.\n\n");
    });
}
