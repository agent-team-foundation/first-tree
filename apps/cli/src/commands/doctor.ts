import type { Command } from "commander";
import { printResults } from "../core/index.js";
import { print } from "../core/output.js";
import { runDaemonChecks } from "./_shared/doctor-checks.js";

/**
 * Top-level `first-tree-hub doctor` — cross-subsystem readiness check.
 * Phase 1A ships only the daemon-side checks (delegated to `runDaemonChecks`,
 * shared with `daemon doctor`); Phase 3 will push additional tree / git /
 * claude-code binary checks onto the result list before rendering.
 */
export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Cross-subsystem readiness check (daemon, server, WS, agents)")
    .action(async () => {
      print.line("\n  First Tree Hub Doctor\n\n");
      const results = await runDaemonChecks();
      // Phase 3 hook: tree / git / claude-code binary checks land here as
      // additional `CheckResult` entries before `printResults`.
      printResults(results);
    });
}
