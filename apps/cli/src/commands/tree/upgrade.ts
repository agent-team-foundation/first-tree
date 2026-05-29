import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Command } from "commander";

import { channelConfig } from "../../core/channel.js";
import type { CommandContext, SubcommandModule } from "../types.js";
import { ensureAgentContextHooks, formatAgentContextHookMessages } from "./agent-context-hooks.js";
import { readSourceBindingContract } from "./binding-contract.js";
import { removeSourceState, TREE_VERSION_FILE } from "./binding-state.js";
import type { Tier0RuleLayerSummary } from "./rule-layer.js";
import { ensureTier0RuleLayer, validateWorkflowPath } from "./rule-layer.js";
import { copyCanonicalSkills, readBundledSkillVersion } from "./skill-lib.js";
import {
  ensureWhitepaperSymlink,
  upsertLocalTreeGitIgnore,
  upsertSourceIntegrationFiles,
} from "./source-integration.js";
import { syncTreeSourceRepoIndex } from "./source-repo-index.js";
import { describeTemplateWriteResult } from "./template-write.js";
import { readTreeIdentityContract, syncTreeIdentityFiles } from "./tree-identity.js";

type UpgradeSummary = {
  bundledSkillVersion: string;
  targetKind: "source" | "tree";
  targetRoot: string;
  tier0RuleLayer?: Tier0RuleLayerSummary;
};

export const UPGRADE_USAGE = `usage: first-tree tree upgrade [--tree-path PATH]

Refresh local first-tree integration and tree metadata.

Options:
  --tree-path PATH  upgrade a tree repo from another working directory
  --help            show this help message`;

function configureUpgradeCommand(command: Command): void {
  command.option("--tree-path <path>", "upgrade a tree repo from another working directory");
}

function resolveTargetRoot(command: Command): string {
  const options = command.opts() as { treePath?: string };
  return options.treePath ? resolve(process.cwd(), options.treePath) : process.cwd();
}

function upgradeSourceRoot(targetRoot: string, bundledSkillVersion: string): UpgradeSummary {
  const sourceBinding = readSourceBindingContract(targetRoot);
  if (sourceBinding === undefined || sourceBinding.treeRepoName === undefined) {
    throw new Error("No First Tree source/workspace binding was found in `AGENTS.md` or `CLAUDE.md`.");
  }

  copyCanonicalSkills(targetRoot);
  ensureWhitepaperSymlink(targetRoot);
  upsertLocalTreeGitIgnore(targetRoot);
  upsertSourceIntegrationFiles(targetRoot, sourceBinding.treeRepoName, {
    binName: channelConfig.binName,
    bindingMode: sourceBinding.bindingMode,
    entrypoint: sourceBinding.entrypoint,
    treeMode: sourceBinding.treeMode,
    treeRepoName: sourceBinding.treeRepoName,
    treeRepoUrl: sourceBinding.treeRepoUrl,
    workspaceId: sourceBinding.workspaceId,
  });
  removeSourceState(targetRoot);
  ensureAgentContextHooks(targetRoot);

  return {
    bundledSkillVersion,
    targetKind: "source",
    targetRoot,
  };
}

function upgradeTreeRoot(targetRoot: string, bundledSkillVersion: string): UpgradeSummary {
  const treeIdentity = readTreeIdentityContract(targetRoot);
  if (treeIdentity === undefined) {
    throw new Error("No managed tree identity was found in `AGENTS.md` or `CLAUDE.md`.");
  }

  copyCanonicalSkills(targetRoot);
  ensureWhitepaperSymlink(targetRoot);
  upsertLocalTreeGitIgnore(targetRoot);
  writeFileSync(join(targetRoot, TREE_VERSION_FILE), `${bundledSkillVersion}\n`);
  const tier0RuleLayer = ensureTier0RuleLayer(targetRoot);
  syncTreeIdentityFiles(targetRoot, treeIdentity);
  syncTreeSourceRepoIndex(targetRoot);
  ensureAgentContextHooks(targetRoot);

  return {
    bundledSkillVersion,
    targetKind: "tree",
    targetRoot,
    tier0RuleLayer,
  };
}

export function upgradeTargetRoot(targetRoot: string): UpgradeSummary {
  const bundledSkillVersion = readBundledSkillVersion();
  const treeIdentity = readTreeIdentityContract(targetRoot);

  if (treeIdentity !== undefined) {
    return upgradeTreeRoot(targetRoot, bundledSkillVersion);
  }

  const sourceBinding = readSourceBindingContract(targetRoot);
  if (sourceBinding !== undefined) {
    return upgradeSourceRoot(targetRoot, bundledSkillVersion);
  }

  throw new Error(
    "This folder is neither a bound source/workspace root nor a tree repo. Run `first-tree tree init` first, or pass `--tree-path <path>`.",
  );
}

function runUpgradeCommand(context: CommandContext): void {
  try {
    const targetRoot = resolveTargetRoot(context.command);
    const summary = upgradeTargetRoot(targetRoot);
    const hookMessages = formatAgentContextHookMessages(ensureAgentContextHooks(targetRoot));

    if (context.options.json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    console.log("Context Tree Upgrade\n");
    console.log(`  Target root:           ${summary.targetRoot}`);
    console.log(`  Target kind:           ${summary.targetKind}`);
    console.log(`  Bundled skill version: ${summary.bundledSkillVersion}`);
    if (summary.tier0RuleLayer) {
      console.log(
        `  ${describeTemplateWriteResult(validateWorkflowPath(summary.targetRoot), summary.tier0RuleLayer.validate)}`,
      );
    }
    for (const message of hookMessages) {
      console.log(`  ${message}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export const upgradeCommand: SubcommandModule = {
  name: "upgrade",
  alias: "",
  summary: "",
  description: "Refresh local first-tree integration and tree metadata.",
  action: runUpgradeCommand,
  configure: configureUpgradeCommand,
};
