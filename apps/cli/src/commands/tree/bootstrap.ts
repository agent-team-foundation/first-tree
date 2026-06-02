import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { TREE_PROGRESS_FILE, TREE_VERSION_FILE } from "./binding-state.js";
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
  renderTreeAgentsInstructions,
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

function ensureClaudeSymlink(targetRoot: string): void {
  const claudePath = join(targetRoot, "CLAUDE.md");
  if (existsSync(claudePath)) {
    return;
  }

  symlinkSync("AGENTS.md", claudePath);
}

export function bootstrapTreeRoot(targetRoot: string, options?: BootstrapOptions): BootstrapSummary {
  const treeMode = options?.treeMode === "shared" ? "shared" : "dedicated";
  const treeRepoName = repoNameForRoot(targetRoot);

  ensureGitRepo(targetRoot);
  copyCanonicalSkills(targetRoot);
  ensureWhitepaperSymlink(targetRoot);
  upsertLocalTreeGitIgnore(targetRoot);

  writeIfMissing(join(targetRoot, "NODE.md"), renderRootNode("Context Tree"));
  writeIfMissing(join(targetRoot, "AGENTS.md"), renderTreeAgentsInstructions());
  ensureClaudeSymlink(targetRoot);
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
