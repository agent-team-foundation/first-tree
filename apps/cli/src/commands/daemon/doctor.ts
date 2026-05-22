import type { Command } from "commander";
import { printResults } from "../../core/index.js";
import { print } from "../../core/output.js";
import { runDaemonChecks } from "../_shared/doctor-checks.js";

/**
 * `daemon doctor` — environment readiness for the local daemon. The full
 * check list lives in `_shared/doctor-checks.ts`; the top-level `doctor`
 * shares it and will append cross-subsystem checks (tree / git / claude-code
 * binary) once Phase 3 wires those subsystems through.
 */
export function registerDaemonDoctorCommand(daemon: Command): void {
  daemon
    .command("doctor")
    .description("Check daemon environment readiness (node, config, server, WS, agents, service)")
    .action(async () => {
      print.line("\n  First Tree Hub Daemon Doctor\n\n");
      const results = await runDaemonChecks();
      printResults(results);
    });
}
