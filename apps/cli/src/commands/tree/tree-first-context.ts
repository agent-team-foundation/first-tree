import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { TREE_SOURCE_REPOS_FILE } from "./binding-state.js";
import { readSourceBindingContract } from "./binding-contract.js";
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
  const repoContext = buildRepoContextSection(
    repos,
    resolved.currentEntrypoint,
    resolved.entrypointLabel,
  );

  if (repoContext !== null) {
    sections.push(repoContext);
  }

  return {
    additionalContext: `${sections.join("\n\n---\n\n")}\n`,
    treeRoot: resolved.treeRoot,
  };
}

function resolveTreeContextRoot(currentRoot: string): ResolvedTreeContextRoot | null {
  if (readTreeIdentityContract(currentRoot) !== undefined) {
    return {
      entrypointLabel: "tree repo root",
      treeRoot: currentRoot,
    };
  }

  const sourceBinding = readSourceBindingContract(currentRoot);
  if (sourceBinding === undefined || sourceBinding.treeRepoName === undefined) {
    return null;
  }

  const siblingRoot = join(dirname(currentRoot), sourceBinding.treeRepoName);
  if (readTreeIdentityContract(siblingRoot) !== undefined) {
    return {
      currentEntrypoint: sourceBinding.entrypoint,
      entrypointLabel: "bound source/workspace root",
      treeRoot: siblingRoot,
    };
  }

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
