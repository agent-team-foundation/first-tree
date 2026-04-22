/**
 * gardener install-workflow — scaffold a GitHub Actions workflow in the
 * caller's codebase repo that replaces the gardener service with an
 * event-driven push-mode sync.
 *
 * The generated workflow invokes `first-tree gardener comment` on every
 * PR open/synchronize/merge/close. On merge it creates a tree-repo
 * issue and (with --assign-owners) assigns the cited NODE owners.
 *
 * What this command does NOT do:
 *   - install the `TREE_REPO_TOKEN` secret — that needs `gh secret set`,
 *     which the calling agent runs after prompting the user about scope
 *     tradeoffs (see skills/gardener/references/workflow-mode.md)
 *   - create or push the PR adding the workflow — we just write the file
 *
 * Keeping both out of the CLI is deliberate: the secret-setup flow is
 * security-sensitive (the agent has to surface caveats), and the commit
 * step varies per repo.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const INSTALL_WORKFLOW_USAGE = `usage: first-tree gardener install-workflow --tree-repo <owner/name> [options]

Scaffold .github/workflows/first-tree-sync.yml in the current repo so
that every source PR triggers the gardener sync flow instead of relying
on a long-running gardener service.

This is "push mode" — use it when the codebase repo is willing to host
the workflow. For codebases you don't have push access to, keep using
the gardener service in pull mode (see the gardener skill handbook at
skills/gardener/SKILL.md; the full push-mode walkthrough lives in
skills/first-tree/references/workflow-mode.md).

Options:
  --tree-repo <owner/name>   Tree repo slug (required). Written into the
                             workflow's actions/checkout step.
  --tree-path <dir>          Path inside the runner where the tree is
                             checked out. Default: .first-tree-cache/tree
  --output <file>            Destination path for the workflow. Default:
                             .github/workflows/first-tree-sync.yml
  --node-version <n>         Node version for setup-node. Default: 22
  --force                    Overwrite an existing workflow file.
  --dry-run                  Print the workflow yaml to stdout; do not
                             write any file.
  --help, -h                 Show this help message.

Next steps after install:
  1. Set the TREE_REPO_TOKEN and ANTHROPIC_API_KEY secrets on this
     repo (see skills/first-tree/references/workflow-mode.md for the
     gh-auth-based quick path and the caveats).
  2. Set the ANTHROPIC_API_KEY secret on this repo. Without it,
     gardener comment refuses to post (PR #255) — this is the
     intended fail-closed behaviour when no classifier is wired.
  3. Commit and open a PR for the new workflow file.
  4. Verify the workflow runs once the PR is merged.
`;

export interface InstallWorkflowDeps {
  cwd?: string;
  write?: (line: string) => void;
  /** Injected for tests: override the filesystem write. */
  writeFile?: (path: string, contents: string) => void;
  /** Injected for tests: override existence check. */
  pathExists?: (path: string) => boolean;
}

export interface ParsedInstallWorkflowFlags {
  help: boolean;
  treeRepo?: string;
  treePath: string;
  output: string;
  nodeVersion: string;
  force: boolean;
  dryRun: boolean;
  unknown?: string;
}

const DEFAULT_TREE_PATH = ".first-tree-cache/tree";
const DEFAULT_OUTPUT = ".github/workflows/first-tree-sync.yml";
const DEFAULT_NODE_VERSION = "22";

export function parseInstallWorkflowFlags(
  args: string[],
): ParsedInstallWorkflowFlags {
  const out: ParsedInstallWorkflowFlags = {
    help: false,
    treePath: DEFAULT_TREE_PATH,
    output: DEFAULT_OUTPUT,
    nodeVersion: DEFAULT_NODE_VERSION,
    force: false,
    dryRun: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--force") {
      out.force = true;
      continue;
    }
    if (arg === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (arg === "--tree-repo") {
      out.treeRepo = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--tree-path") {
      out.treePath = args[i + 1] ?? DEFAULT_TREE_PATH;
      i += 1;
      continue;
    }
    if (arg === "--output") {
      out.output = args[i + 1] ?? DEFAULT_OUTPUT;
      i += 1;
      continue;
    }
    if (arg === "--node-version") {
      out.nodeVersion = args[i + 1] ?? DEFAULT_NODE_VERSION;
      i += 1;
      continue;
    }
    out.unknown = arg;
    return out;
  }
  return out;
}

/**
 * Validate that `value` is a plausible `owner/name` slug. Guards
 * against callers passing full URLs or quoted strings that would
 * silently produce a broken workflow yaml.
 */
export function isValidRepoSlug(value: string): boolean {
  return /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(value);
}

export interface BuildWorkflowYamlInput {
  treeRepo: string;
  treePath: string;
  nodeVersion: string;
}

/**
 * Build the yaml body for .github/workflows/first-tree-sync.yml. Kept
 * as a pure function so tests can pin the exact output without touching
 * the filesystem.
 */
export function buildWorkflowYaml(input: BuildWorkflowYamlInput): string {
  const { treeRepo, treePath, nodeVersion } = input;
  return `# Managed by \`first-tree gardener install-workflow\`.
# Regenerate with that command (re-run with --force) rather than hand-editing —
# the gardener skill may roll the template forward on upgrades.
name: First-Tree Sync

on:
  pull_request:
    types: [opened, synchronize, reopened, closed]

jobs:
  tree-sync:
    # Skip fork PRs: GitHub withholds secrets (TREE_REPO_TOKEN,
    # ANTHROPIC_API_KEY) from fork workflows, so the job can't do its
    # work. A skipped check is less misleading than a failed one.
    # Also skip first-tree's own sync PRs so gardener never reviews itself.
    if: \${{ github.event.pull_request.head.repo.full_name == github.repository && !contains(github.event.pull_request.labels.*.name, 'first-tree:sync') }}
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: write
      pull-requests: write
    env:
      TREE_REPO_TOKEN: \${{ secrets.TREE_REPO_TOKEN }}
      ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
      GH_TOKEN: \${{ github.token }}
      # Optional: when set, gardener comment posts an AI-classified verdict.
      # When unset, gardener comment refuses to post (see PR #255). Set
      # ANTHROPIC_API_KEY as a repo secret to enable posting.
      ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
      GARDENER_CLASSIFIER_MODEL: \${{ secrets.GARDENER_CLASSIFIER_MODEL }}
    steps:
      - name: Checkout source repo
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Checkout tree repo
        uses: actions/checkout@v4
        with:
          repository: ${treeRepo}
          token: \${{ secrets.TREE_REPO_TOKEN }}
          path: ${treePath}

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: "${nodeVersion}"

      - name: Run first-tree gardener
        run: |
          npx -p first-tree first-tree gardener comment \\
            --pr \${{ github.event.pull_request.number }} \\
            --repo \${{ github.repository }} \\
            --tree-path ${treePath} \\
            --assign-owners
`;
}

export type InstallWorkflowStatus =
  | "written"
  | "dry_run"
  | "skipped_exists"
  | "failed";

export interface InstallWorkflowResult {
  status: InstallWorkflowStatus;
  outputPath: string;
  message: string;
}

export async function runInstallWorkflow(
  args: string[],
  deps: InstallWorkflowDeps = {},
): Promise<number> {
  const write = deps.write ?? ((line: string): void => console.log(line));
  const cwd = deps.cwd ?? process.cwd();
  const writeFile = deps.writeFile ?? ((path, contents): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf-8");
  });
  const pathExists = deps.pathExists ?? existsSync;

  const flags = parseInstallWorkflowFlags(args);
  if (flags.help) {
    write(INSTALL_WORKFLOW_USAGE);
    return 0;
  }
  if (flags.unknown) {
    write(`Unknown install-workflow option: ${flags.unknown}`);
    write(INSTALL_WORKFLOW_USAGE);
    return 1;
  }
  if (!flags.treeRepo) {
    write("--tree-repo <owner/name> is required");
    write(INSTALL_WORKFLOW_USAGE);
    return 1;
  }
  if (!isValidRepoSlug(flags.treeRepo)) {
    write(
      `--tree-repo must be an \`owner/name\` slug (got: ${flags.treeRepo})`,
    );
    return 1;
  }

  const yaml = buildWorkflowYaml({
    treeRepo: flags.treeRepo,
    treePath: flags.treePath,
    nodeVersion: flags.nodeVersion,
  });

  const absOutput = resolve(cwd, flags.output);

  if (flags.dryRun) {
    write(yaml);
    write("");
    write(`# dry-run — nothing written. Target path: ${absOutput}`);
    return 0;
  }

  if (pathExists(absOutput) && !flags.force) {
    write(
      `\u23ed ${flags.output} already exists — pass --force to overwrite`,
    );
    return 1;
  }

  try {
    writeFile(absOutput, yaml);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    write(`\u274c failed to write ${absOutput}: ${message}`);
    return 1;
  }

  write(`\u2713 wrote ${flags.output}`);
  write("");
  write("Next steps:");
  write(
    "  1. Set the TREE_REPO_TOKEN and ANTHROPIC_API_KEY secrets on this",
  );
  write(
    "     repo. Quick path via your local gh login (review the caveats in",
  );
  write(
    "     skills/first-tree/references/workflow-mode.md first):",
  );
  write(
    `       gh auth token | gh secret set TREE_REPO_TOKEN --repo <codebase-owner>/<repo> --body -`,
  );
  write(
    `       printf '%s' \"$ANTHROPIC_API_KEY\" | gh secret set ANTHROPIC_API_KEY --repo <codebase-owner>/<repo> --body -`,
  );
  write(
    `     The token needs \`issues:write\` and \`contents:read\` on ${flags.treeRepo}.`,
  );
  write(
    "  2. Set ANTHROPIC_API_KEY on this repo. Without it, gardener comment",
  );
  write(
    "     refuses to post (PR #255 fail-closed). Quick path:",
  );
  write(
    `       gh secret set ANTHROPIC_API_KEY --repo <codebase-owner>/<repo>`,
  );
  write("  3. Commit and open a PR for the new workflow file.");
  write(
    "  4. Merge a test PR on the codebase and confirm an issue opens on",
  );
  write(`     https://github.com/${flags.treeRepo}/issues`);

  return 0;
}
