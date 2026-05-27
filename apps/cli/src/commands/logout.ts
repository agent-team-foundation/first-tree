import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { defaultConfigDir } from "@first-tree/shared/config";
import { select } from "@inquirer/prompts";
import type { Command } from "commander";
import { getClientServiceStatus, isServiceSupported, stopClientService } from "../core/index.js";
import { print } from "../core/output.js";

/**
 * Two-step confirmation prompt before `--purge` wipes `client.yaml`. The
 * operator commonly types `logout` by muscle memory; a quiet `--purge` flag
 * pushed onto the end (or pasted from a runbook) would silently destroy the
 * machine's identity. This prompt forces a deliberate selection.
 *
 * Non-TTY guard: `select` from `@inquirer/prompts` hangs forever when stdin
 * is not a TTY (systemd ExecStart, cron, CI, piped). Detect that case and
 * refuse with a clear message pointing at `--yes`. Exits the process with
 * code 1 so a caller script sees the failure rather than waiting for input
 * that will never come.
 *
 * Returns `true` if the operator confirmed purge, `false` if they cancelled.
 * Exported for testing — the prompt is otherwise impossible to drive from
 * a unit test without mocking `@inquirer/prompts` directly.
 */
export async function confirmPurge(): Promise<boolean> {
  if (!process.stdin.isTTY) {
    print.line("\n  ✗ --purge requires interactive confirmation, but stdin is not a TTY.\n");
    print.line("    Re-run with --yes to skip the prompt (only if you've confirmed the consequences).\n\n");
    process.exit(1);
  }
  print.line("\n  ⚠️  --purge will permanently remove this computer's identity (client.yaml).\n");
  print.line("     Next `first-tree login` will register a brand-new computer row on the Hub.\n");
  print.line("     The existing row will become an orphan until the server's dedup merges it back\n");
  print.line("     (only if the same user reconnects from the same hostname + OS).\n\n");
  const choice = await select<"purge" | "cancel">({
    message: "How would you like to continue?",
    choices: [
      { name: "Cancel — keep client.yaml", value: "cancel" },
      { name: "Purge — I want to lose this computer's identity", value: "purge" },
    ],
  });
  return choice === "purge";
}

/**
 * `first-tree logout` — symmetric counterpart to `login`. Stops the
 * background daemon and removes persisted credentials. `client.yaml` is
 * kept by default (it carries harmless config like `server.url` and the
 * stable `client.id`); `--purge` opts in to wiping that too, after a
 * two-step confirmation to protect against muscle-memory mistakes.
 */
export function registerLogoutCommand(program: Command): void {
  program
    .command("logout")
    .description("Disconnect from the Hub — stop daemon and clear credentials (symmetric to `login`)")
    .option("--purge", "Also remove client.yaml (server.url etc.); default keeps it")
    .option("--yes", "Skip the interactive --purge confirmation (required in non-TTY environments)")
    .action(async (options: { purge?: boolean; yes?: boolean }) => {
      // 0. --purge guardrail: explicit confirmation unless --yes is set.
      // Done BEFORE stopping the daemon so a cancel leaves the install in
      // exactly the state we found it.
      if (options.purge && !options.yes) {
        try {
          const confirmed = await confirmPurge();
          if (!confirmed) {
            print.line("\n  Cancelled. client.yaml retained.\n\n");
            return;
          }
        } catch (err) {
          // Inquirer throws `ExitPromptError` on Ctrl+C — same UX as cancel.
          if ((err as { name?: string }).name === "ExitPromptError") {
            print.line("\n  Cancelled. client.yaml retained.\n\n");
            return;
          }
          throw err;
        }
      }
      // 1. Stop daemon (best-effort).
      if (isServiceSupported()) {
        const svc = getClientServiceStatus();
        if (svc.state === "active") {
          const res = stopClientService();
          print.line(`  ✓ Stopped ${svc.platform} service${res.ok ? "" : ` (warning: ${res.reason})`}\n`);
        }
      }
      // 2. Remove credentials.
      const credsPath = join(defaultConfigDir(), "credentials.json");
      if (existsSync(credsPath)) {
        unlinkSync(credsPath);
        print.line(`  ✓ Removed credentials\n`);
      }
      // 3. --purge: also remove client.yaml.
      if (options.purge) {
        const yamlPath = join(defaultConfigDir(), "client.yaml");
        if (existsSync(yamlPath)) {
          unlinkSync(yamlPath);
          print.line(`  ✓ Removed client.yaml\n`);
        }
      }
      print.line(`\n  Logged out. Run \`first-tree login <token>\` to reconnect.\n\n`);
    });
}
