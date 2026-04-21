/**
 * Tree product dispatcher.
 *
 * Routes `first-tree tree <command>` into the engine. The top-level
 * `src/cli.ts` lazy-loads this module; nothing here should import from
 * another product (e.g. breeze) so the umbrella CLI can stay lightweight.
 */

export const TREE_USAGE = `usage: first-tree tree <command>

  This CLI is designed for agents, not humans. Let your agent handle it.
  New to first-tree? Run \`first-tree tree help onboarding\` first.

Commands:
  inspect               Classify the current folder before onboarding
  status                Alias for \`inspect\` (human-friendly name)
  init                  High-level onboarding wrapper for repo/workspace roots
  bootstrap             Low-level tree-repo bootstrap for an explicit tree checkout
  bind                  Bind the current repo/workspace root to an existing tree repo
  integrate             Install the first-tree skill and source-integration block without touching the tree repo
  workspace             Workspace helpers (currently: sync child repos to a shared tree)
  publish               Publish a tree repo to GitHub
  verify                Run verification checks against a tree repo
  upgrade               Refresh source/workspace integration or tree metadata
  review                Run Claude Code PR review (CI helper)
  generate-codeowners   Generate .github/CODEOWNERS from tree ownership
  invite                Invite a new member to the Context Tree
  join                  Accept an invite and join a Context Tree
  inject-context        Output Claude Code SessionStart hook payload from NODE.md
  help                  Show help for a topic (e.g. \`help onboarding\`)

Options:
  --help                Show this help message

Common examples:
  first-tree tree inspect --json
  first-tree tree init
  first-tree tree init --tree-path ../org-context --tree-mode shared
  first-tree tree init --scope workspace --tree-path ../org-context --tree-mode shared --sync-members
  first-tree tree bootstrap --here
  first-tree tree bind --tree-path ../org-context --tree-mode shared
  first-tree tree publish --tree-path ../org-context
  mkdir my-org-tree && cd my-org-tree && git init && first-tree tree bootstrap --here
  first-tree tree verify --tree-path ../my-org-tree
  first-tree tree upgrade --tree-path ../my-org-tree

Note:
  \`first-tree tree bootstrap --here\` is for when the current repo is already the tree repo.
  Legacy alias: \`first-tree tree init tree ...\`
`;

type Output = (text: string) => void;

export async function runTree(
  args: string[],
  output: Output = console.log,
): Promise<number> {
  const write = (text: string): void => output(text);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    write(TREE_USAGE);
    return 0;
  }

  const command = args[0];

  switch (command) {
    case "init": {
      const { runInit } = await import(
        "#products/tree/engine/commands/init.js"
      );
      return runInit(args.slice(1));
    }
    case "bootstrap": {
      const { runBootstrap } = await import(
        "#products/tree/engine/commands/bootstrap.js"
      );
      return runBootstrap(args.slice(1), write);
    }
    case "inspect":
    case "status": {
      const { runInspect } = await import(
        "#products/tree/engine/commands/inspect.js"
      );
      return runInspect(args.slice(1));
    }
    case "bind": {
      const { runBind } = await import(
        "#products/tree/engine/commands/bind.js"
      );
      return runBind(args.slice(1));
    }
    case "integrate": {
      const { runIntegrate } = await import(
        "#products/tree/engine/commands/integrate.js"
      );
      return runIntegrate(args.slice(1));
    }
    case "workspace": {
      const { runWorkspace } = await import(
        "#products/tree/engine/commands/workspace.js"
      );
      return runWorkspace(args.slice(1));
    }
    case "verify": {
      const { runVerify } = await import(
        "#products/tree/engine/commands/verify.js"
      );
      return runVerify(args.slice(1));
    }
    case "publish": {
      const { runPublish } = await import(
        "#products/tree/engine/commands/publish.js"
      );
      return runPublish(args.slice(1));
    }
    case "upgrade": {
      const { runUpgrade } = await import(
        "#products/tree/engine/commands/upgrade.js"
      );
      return runUpgrade(args.slice(1));
    }
    case "sync": {
      write(
        "❌ `first-tree tree sync` has moved to `first-tree gardener sync`.",
      );
      write(
        "   The drift-detection command now lives under the gardener product",
      );
      write(
        "   alongside `gardener comment` and `gardener respond`. Run",
      );
      write(
        "   `first-tree gardener sync --help` for usage. Slash commands",
      );
      write(
        "   (/first-tree-sync, /first-tree-sync-loop, …) are unchanged.",
      );
      return 1;
    }
    case "review": {
      const { runReview } = await import(
        "#products/tree/engine/commands/review.js"
      );
      return runReview(args.slice(1));
    }
    case "generate-codeowners": {
      const { runGenerateCodeowners } = await import(
        "#products/tree/engine/commands/generate-codeowners.js"
      );
      return runGenerateCodeowners(args.slice(1));
    }
    case "inject-context": {
      const { runInjectContext } = await import(
        "#products/tree/engine/commands/inject-context.js"
      );
      return runInjectContext(args.slice(1));
    }
    case "invite": {
      const { runInvite } = await import(
        "#products/tree/engine/commands/invite.js"
      );
      return runInvite(args.slice(1));
    }
    case "join": {
      const { runJoin } = await import(
        "#products/tree/engine/commands/join.js"
      );
      return runJoin(args.slice(1));
    }
    case "help":
      return (
        await import("#products/tree/engine/commands/help.js")
      ).runHelp(args.slice(1), write);
    default:
      write(`Unknown command: ${command}`);
      write(TREE_USAGE);
      return 1;
  }
}
