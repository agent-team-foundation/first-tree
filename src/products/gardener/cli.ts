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

Primary commands (start here):
  install-workflow      Scaffold .github/workflows/first-tree-sync.yml in
                        a codebase repo (push mode: replaces the long-
                        running daemon with event-driven per-PR sync).
  start                 Launch the pull-mode daemon in the background
                        (writes ~/.gardener/config.json; launchd on macOS
                        or detached spawn otherwise).
  stop                  Stop the pull-mode daemon.
  status                Report daemon PID, schedule, and last-run state.
  run-once              Execute both sweeps inline and exit (useful for
                        cron or CI-style deployments).

Agent commands (invoked by the daemon, breeze, or CI — not normally by humans):
  sync                  Detect drift between a tree repo and its bound
                        sources. Writes proposals and optionally opens a
                        PR against the tree repo with applied edits.
  comment               Review source-repo PRs/issues against the tree
                        and post structured verdict comments.
  respond               Fix sync PRs based on reviewer feedback.
  daemon                Foreground loop invoked by \`start\`; not for
                        direct human use.

Options:
  --help, -h            Show this help message
  --version, -v         Show gardener product version

Examples (humans):
  first-tree gardener install-workflow --tree-repo owner/tree-repo
  first-tree gardener start --tree-path ../my-tree \\
      --code-repo acme/web --code-repo acme/api \\
      --gardener-interval 5m --sync-interval 1h --assign-owners
  first-tree gardener status
  first-tree gardener run-once
  first-tree gardener stop

Examples (agent / CI):
  first-tree gardener sync --tree-path ../my-tree --propose
  first-tree gardener sync --apply
  first-tree gardener comment --pr 42 --repo owner/name
  first-tree gardener respond --pr 123 --repo owner/name
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
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (apiKey) {
        const { createAnthropicClassifier } = await import(
          "./engine/classifiers/anthropic.js"
        );
        const model = process.env.GARDENER_CLASSIFIER_MODEL;
        return runComment(args.slice(1), {
          write,
          classifier: createAnthropicClassifier({ apiKey, model }),
        });
      }
      return runComment(args.slice(1), { write });
    }
    case "install-workflow": {
      const { runInstallWorkflow } = await import(
        "./engine/commands/install-workflow.js"
      );
      return runInstallWorkflow(args.slice(1), { write });
    }
    case "start": {
      const { runStart } = await import("./engine/commands/start.js");
      return runStart(args.slice(1), { write });
    }
    case "stop": {
      const { runStop } = await import("./engine/commands/stop.js");
      return runStop(args.slice(1), { write });
    }
    case "status": {
      const { runStatus } = await import("./engine/commands/status.js");
      return runStatus(args.slice(1), { write });
    }
    case "run-once": {
      const { runRunOnce } = await import("./engine/commands/run-once.js");
      return runRunOnce(args.slice(1), { write });
    }
    case "daemon": {
      const { runDaemon } = await import("./engine/commands/daemon.js");
      return runDaemon(args.slice(1), { write });
    }
    default:
      write(`Unknown gardener command: ${command}`);
      write(GARDENER_USAGE);
      return 1;
  }
}
