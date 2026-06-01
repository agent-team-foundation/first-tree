import type { Command } from "commander";
import { print } from "../../core/output.js";
import { renderAuthBlock, renderHubBlock, renderServiceBlock } from "../_shared/status-blocks.js";

/**
 * `daemon status` — local daemon-only view (service state + server binding +
 * auth health). The cross-subsystem overview lives under the top-level
 * `status` command (which also adds CLI version + agents). Both surfaces
 * share the same render blocks, so output stays consistent.
 */
export function registerDaemonStatusCommand(daemon: Command): void {
  daemon
    .command("status")
    .description("Show daemon service state + server binding + auth health (local-only, < 1s)")
    .action(() => {
      print.line("\n");
      renderServiceBlock();
      renderHubBlock();
      renderAuthBlock();
      print.line("\n");
    });
}
