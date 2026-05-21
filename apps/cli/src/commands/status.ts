import type { Command } from "commander";
import { print } from "../core/output.js";
import {
  renderAgentsBlock,
  renderAuthBlock,
  renderCliVersionBlock,
  renderHubBlock,
  renderServiceBlock,
} from "./_shared/status-blocks.js";

/**
 * Top-level `first-tree-hub status` — one-screen overview across every
 * subsystem (CLI version, daemon, hub binding, auth health, agents). For a
 * daemon-only view (faster, fewer lines), use `daemon status`. Future tree /
 * chat status blocks plug in once Phase 3 wires those subsystems through.
 */
export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show CLI, daemon, hub, auth, and agent status (one-screen overview)")
    .action(() => {
      print.line("\n");
      renderCliVersionBlock();
      renderServiceBlock();
      renderHubBlock();
      renderAuthBlock();
      renderAgentsBlock();
    });
}
