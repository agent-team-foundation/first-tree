import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { buildTreeId, TREE_PROGRESS_FILE, TREE_VERSION_FILE, treeStatePath, writeTreeState } from "./binding-state.js";
import type { Tier0RuleLayerSummary } from "./rule-layer.js";
import { ensureTier0RuleLayer } from "./rule-layer.js";
import { isGitRepoRoot, repoNameForRoot, runCommand } from "./shared.js";
import { copyCanonicalSkills } from "./skill-lib.js";
import { ensureWhitepaperSymlink, upsertLocalTreeGitIgnore } from "./source-integration.js";
import { syncTreeSourceRepoIndex } from "./source-repo-index.js";
import { syncTreeIdentityFiles } from "./tree-identity.js";
import {
  renderCodeReviewerAgentTemplate,
  renderDefaultMemberNode,
  renderDeveloperAgentTemplate,
  renderMembersDomainNode,
  renderOrgConfigPlaceholder,
  renderRootNode,
  renderTreeProgress,
} from "./tree-templates.js";

type BootstrapOptions = {
  here?: boolean;
  treeMode?: "dedicated" | "shared";
  treePath?: string;
};

type BootstrapSummary = {
  root: string;
  tier0RuleLayer: Tier0RuleLayerSummary;
  treeMode: "dedicated" | "shared";
  treeRepoName: string;
};

function ensureGitRepo(root: string): void {
  if (isGitRepoRoot(root)) {
    return;
  }

  mkdirSync(root, { recursive: true });
  runCommand("git", ["init"], root);
}

function writeIfMissing(path: string, contents: string): void {
  if (existsSync(path)) {
    return;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${contents.trimEnd()}\n`);
}

export function bootstrapTreeRoot(targetRoot: string, options?: BootstrapOptions): BootstrapSummary {
  const treeMode = options?.treeMode === "shared" ? "shared" : "dedicated";
  const treeRepoName = repoNameForRoot(targetRoot);

  ensureGitRepo(targetRoot);
  copyCanonicalSkills(targetRoot);
  ensureWhitepaperSymlink(targetRoot);
  upsertLocalTreeGitIgnore(targetRoot);

  writeIfMissing(join(targetRoot, "NODE.md"), renderRootNode("Context Tree"));
  writeIfMissing(join(targetRoot, "members", "NODE.md"), renderMembersDomainNode());
  writeIfMissing(join(targetRoot, "members", "owner", "NODE.md"), renderDefaultMemberNode());
  writeIfMissing(join(targetRoot, ".first-tree", "agent-templates", "developer.yaml"), renderDeveloperAgentTemplate());
  writeIfMissing(
    join(targetRoot, ".first-tree", "agent-templates", "code-reviewer.yaml"),
    renderCodeReviewerAgentTemplate(),
  );
  writeIfMissing(join(targetRoot, ".first-tree", "org.yaml"), renderOrgConfigPlaceholder());
  writeIfMissing(join(targetRoot, TREE_VERSION_FILE), "0.4.0-alpha.1");
  writeIfMissing(join(targetRoot, TREE_PROGRESS_FILE), renderTreeProgress());
  const tier0RuleLayer = ensureTier0RuleLayer(targetRoot);

  // Persist tree identity to `.first-tree/tree.json`. This is the canonical
  // identity store now that tree-side AGENTS.md / CLAUDE.md no longer ship
  // with a managed identity block. `syncTreeIdentityFiles` below still
  // refreshes the legacy framework block when those files exist (so existing
  // trees keep working), but it is no longer the source of truth.
  if (!existsSync(treeStatePath(targetRoot))) {
    writeTreeState(targetRoot, {
      treeId: buildTreeId(treeRepoName),
      treeMode,
      treeRepoName,
    });
  }

  syncTreeIdentityFiles(targetRoot, {
    treeMode,
    treeRepoName,
  });

  syncTreeSourceRepoIndex(targetRoot);

  return {
    root: targetRoot,
    tier0RuleLayer,
    treeMode,
    treeRepoName,
  };
}
