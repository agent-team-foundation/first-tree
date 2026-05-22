import type { Command } from "commander";

/**
 * `first-tree-hub github` — placeholder namespace. Phase 3 T3.1 of the
 * `first-tree-hub` ↔ `first-tree` repo merge wires this through to the
 * shared `first-tree github scan` surface. For Phase 1A the namespace is
 * visible (so `--help` shows the full eventual shape and users can
 * discover what's coming) but has no subcommands.
 */
export function registerGithubCommands(program: Command): void {
  program.command("github").description("GitHub scan / notification operations (Phase 3 — not yet implemented)");
}
