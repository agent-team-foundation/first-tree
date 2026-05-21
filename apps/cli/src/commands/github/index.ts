import type { Command } from "commander";

/**
 * `first-tree-hub github` — placeholder namespace. Phase 3 T3.1 of the
 * `first-tree-hub` ↔ `first-tree` repo merge wires this through to the
 * shared `first-tree github scan` surface. For now the registrar attaches
 * the namespace so `--help` documents the eventual shape, but no
 * subcommands are bound yet.
 */
export function registerGithubCommands(program: Command): void {
  program
    .command("github", { hidden: true })
    .description("GitHub scan / notification operations (placeholder — implementation lands in Phase 3)");
}
