import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { discoverWorkspaceRoot, readWorkspaceManifest } from "../../core/workspace.js";
import { readSourceBindingContract } from "./binding-contract.js";
import { TREE_SOURCE_REPOS_FILE } from "./binding-state.js";
import { buildSourceRepoIndexTable } from "./source-repo-index.js";
import { readTreeIdentityContract } from "./tree-identity.js";
import { listKnownTreeCodeRepos } from "./tree-repo-registry.js";

const ROOT_NODE_FILE = "NODE.md";

type ResolvedTreeContextRoot = {
  currentEntrypoint?: string;
  entrypointLabel: string;
  treeRoot: string;
};

export type TreeFirstContextBundle = {
  additionalContext: string;
  treeRoot: string;
};

export function buildTreeFirstContextBundle(currentRoot: string): TreeFirstContextBundle | null {
  const resolved = resolveTreeContextRoot(currentRoot);

  if (resolved === null) {
    return readFallbackLocalNode(currentRoot);
  }

  const nodePath = join(resolved.treeRoot, ROOT_NODE_FILE);
  if (!existsSync(nodePath)) {
    return null;
  }

  const rootNode = readFileSync(nodePath, "utf-8").trimEnd();
  const repos = listKnownTreeCodeRepos(resolved.treeRoot);
  const sections = [rootNode];
  const repoContext = buildRepoContextSection(repos, resolved.currentEntrypoint, resolved.entrypointLabel);

  if (repoContext !== null) {
    sections.push(repoContext);
  }

  return {
    additionalContext: `${sections.join("\n\n---\n\n")}\n`,
    treeRoot: resolved.treeRoot,
  };
}

function resolveTreeContextRoot(currentRoot: string): ResolvedTreeContextRoot | null {
  // Case 1: cwd itself is a tree repo root.
  if (readTreeIdentityContract(currentRoot) !== undefined) {
    return {
      entrypointLabel: "tree repo root",
      treeRoot: currentRoot,
    };
  }

  const sourceBinding = readSourceBindingContract(currentRoot);

  // Case 2 (canonical W1 layout): walk up from cwd to find a
  // `.first-tree/workspace.json` and resolve the tree at
  // `<workspaceRoot>/<manifest.tree>`. This handles every cwd inside a
  // W1 workspace — workspace root itself, a workspace-member subdir, or
  // any other path inside the workspace — even when cwd does not carry a
  // source binding contract of its own.
  const w1Resolved = resolveViaWorkspaceManifest(currentRoot, sourceBinding);
  if (w1Resolved !== null) {
    return w1Resolved;
  }

  // The pre-W1 fallbacks below require a source binding contract at cwd.
  if (sourceBinding === undefined || sourceBinding.treeRepoName === undefined) {
    return null;
  }

  // Case 3 (legacy pre-W1 sibling layout): tree lives at
  // `<dirname(cwd)>/<treeName>`.
  const siblingRoot = join(dirname(currentRoot), sourceBinding.treeRepoName);
  if (readTreeIdentityContract(siblingRoot) !== undefined) {
    return {
      currentEntrypoint: sourceBinding.entrypoint,
      entrypointLabel: "bound source/workspace root",
      treeRoot: siblingRoot,
    };
  }

  // Case 4: ephemeral working copy at `<cwd>/.first-tree/tmp/<treeName>`,
  // used by tasks that clone a tree on demand.
  const tempRoot = join(currentRoot, ".first-tree", "tmp", sourceBinding.treeRepoName);
  if (readTreeIdentityContract(tempRoot) !== undefined) {
    return {
      currentEntrypoint: sourceBinding.entrypoint,
      entrypointLabel: "bound source/workspace root",
      treeRoot: tempRoot,
    };
  }

  return null;
}

function resolveViaWorkspaceManifest(
  currentRoot: string,
  sourceBinding: ReturnType<typeof readSourceBindingContract>,
): ResolvedTreeContextRoot | null {
  const workspaceRoot = discoverWorkspaceRoot(currentRoot);
  if (workspaceRoot === undefined) {
    return null;
  }

  // Tolerate malformed / unreadable manifests; just fall through so the
  // legacy resolution paths still get a chance.
  let manifestTree: string;
  try {
    manifestTree = readWorkspaceManifest(workspaceRoot).tree;
  } catch {
    return null;
  }

  const treeRoot = join(workspaceRoot, manifestTree);
  if (readTreeIdentityContract(treeRoot) === undefined) {
    return null;
  }

  return {
    currentEntrypoint: computeCurrentEntrypoint(currentRoot, workspaceRoot, sourceBinding),
    entrypointLabel: "bound source/workspace root",
    treeRoot,
  };
}

function computeCurrentEntrypoint(
  currentRoot: string,
  workspaceRoot: string,
  sourceBinding: ReturnType<typeof readSourceBindingContract>,
): string {
  // Prefer the explicit entrypoint string when the cwd carries a source
  // binding contract — it is the value the workspace was configured with
  // and matches what the rest of the CLI reports.
  if (sourceBinding?.entrypoint !== undefined) {
    return sourceBinding.entrypoint;
  }

  // Otherwise derive it from the filesystem: cwd's path relative to the
  // workspace root, leading-slash-prefixed. cwd === workspace root yields
  // "/".
  const rel = relative(workspaceRoot, currentRoot);
  return rel === "" ? "/" : `/${rel}`;
}

function readFallbackLocalNode(currentRoot: string): TreeFirstContextBundle | null {
  const nodePath = join(currentRoot, ROOT_NODE_FILE);
  if (!existsSync(nodePath)) {
    return null;
  }

  return {
    additionalContext: readFileSync(nodePath, "utf-8"),
    treeRoot: currentRoot,
  };
}

function buildRepoContextSection(
  repos: ReturnType<typeof listKnownTreeCodeRepos>,
  currentEntrypoint: string | undefined,
  entrypointLabel: string,
): string | null {
  if (repos.length === 0 && currentEntrypoint === undefined) {
    return null;
  }

  const lines = [
    "## Tree-First Cross-Repo Working Context",
    "",
    "- Repo index source: managed code-repo registry block in `AGENTS.md` / `CLAUDE.md`",
    `- Human-readable index: \`${TREE_SOURCE_REPOS_FILE}\` when present`,
    `- Current entrypoint: \`${currentEntrypoint ?? entrypointLabel}\``,
    "",
    "## Managed Code Repos",
    "",
    ...buildSourceRepoIndexTable(repos),
  ];

  return lines.join("\n");
}
