/**
 * Gardener product dispatcher.
 *
 * Routes `first-tree gardener <command>` into the engine. Mirrors the
 * `src/products/tree/cli.ts` pattern: this dispatcher is lightweight,
 * lazy-loads the heavy command implementations, and does not import
 * from other products.
 *
 * Phase 1 ships the `respond` subcommand — a port of the
 * `gardener-respond-manual.md` runbook that fixes sync PRs based on
 * reviewer feedback.
 *
 * Phase 2 adds the `comment` subcommand — a port of the
 * `gardener-comment-manual.md` runbook that reviews open PRs and issues
 * on a source repo against a Context Tree and posts structured verdict
 * comments.
 */

import { readOwnVersion } from "#shared/version.js";

export const GARDENER_USAGE = `usage: first-tree gardener <command>

  Gardener maintains Context Tree repos by detecting drift between a
  tree and the source repos it describes, posting structured verdicts
  on source-repo PRs/issues, and responding to reviewer feedback on
  sync PRs. This CLI is designed for agents, not humans.

Commands:
  sync                  Detect drift between a tree repo and its bound
                        sources. Opens a PR against the tree repo with
                        proposal files and applied edits. Moved from
                        \`first-tree tree sync\` so all tree-maintenance
                        runtime commands live under one product.
  comment               Review source-repo PRs/issues against the tree
  respond               Fix sync PRs based on reviewer feedback
  install-workflow      Scaffold .github/workflows/first-tree-sync.yml in
                        the caller's codebase repo (push mode: replaces
                        the gardener service with an event-driven flow)

Options:
  --help, -h            Show this help message
  --version, -v         Show gardener product version

Examples:
  first-tree gardener sync --help
  first-tree gardener sync --tree-path ../my-tree --propose
  first-tree gardener sync --apply
  first-tree gardener respond --help
  first-tree gardener respond --dry-run
  first-tree gardener respond --pr 123 --repo owner/name
  first-tree gardener comment --help
  first-tree gardener comment --pr 42 --repo owner/name
  first-tree gardener comment --issue 7 --repo owner/name
  first-tree gardener install-workflow --tree-repo owner/tree-repo
`;

type Output = (text: string) => void;

function readGardenerVersion(): string {
  return readOwnVersion(import.meta.url, "src/products/gardener");
}

export async function runGardener(
  args: string[],
  output: Output = console.log,
): Promise<number> {
  const write = (text: string): void => output(text);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    write(GARDENER_USAGE);
    return 0;
  }

  if (args[0] === "--version" || args[0] === "-v") {
    write(readGardenerVersion());
    return 0;
  }

  const command = args[0];

  switch (command) {
    case "sync": {
      const { runSync } = await import(
        "./engine/commands/sync.js"
      );
      return runSync(args.slice(1));
    }
    case "respond": {
      const { runRespond } = await import(
        "./engine/commands/respond.js"
      );
      return runRespond(args.slice(1), { write });
    }
    case "comment": {
      const { runComment } = await import(
        "./engine/commands/comment.js"
      );
      return runComment(args.slice(1), { write });
    }
    case "install-workflow": {
      const { runInstallWorkflow } = await import(
        "./engine/commands/install-workflow.js"
      );
      return runInstallWorkflow(args.slice(1), { write });
    }
    default:
      write(`Unknown gardener command: ${command}`);
      write(GARDENER_USAGE);
      return 1;
  }
}
