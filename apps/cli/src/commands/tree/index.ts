import type { Command } from "commander";

/**
 * `first-tree-hub tree` — placeholder namespace. Phase 3 T3.1 of the
 * `first-tree-hub` ↔ `first-tree` repo merge wires this through to the
 * shared `first-tree tree` command surface. For now the registrar attaches
 * the namespace so `--help` documents the eventual shape, but no
 * subcommands are bound yet.
 */
export function registerTreeCommands(program: Command): void {
  program
    .command("tree", { hidden: true })
    .description("Context Tree operations (placeholder — implementation lands in Phase 3)");
}
