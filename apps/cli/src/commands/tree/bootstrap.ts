import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { Command } from "commander";

import type { CommandContext, SubcommandModule } from "../types.js";
import { TREE_PROGRESS_FILE, TREE_VERSION_FILE } from "./binding-state.js";
import { ensureAgentContextHooks, formatAgentContextHookMessages } from "./agent-context-hooks.js";
import type { Tier0RuleLayerSummary } from "./rule-layer.js";
import { ensureTier0RuleLayer, validateWorkflowPath } from "./rule-layer.js";
import { copyCanonicalSkills } from "./skill-lib.js";
import { syncTreeSourceRepoIndex } from "./source-repo-index.js";
import { ensureWhitepaperSymlink, upsertLocalTreeGitIgnore } from "./source-integration.js";
import { syncTreeIdentityFiles } from "./tree-identity.js";
import { isGitRepoRoot, repoNameForRoot, runCommand } from "./shared.js";
import { describeTemplateWriteResult } from "./template-write.js";
import {
  renderCodeReviewerAgentTemplate,
  renderDeveloperAgentTemplate,
  renderDefaultMemberNode,
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

export const BOOTSTRAP_USAGE = `usage: first-tree tree bootstrap [--here] [--tree-path PATH] [--tree-mode dedicated|shared]

Bootstrap an explicit tree repo checkout.

Options:
  --here             initialize the current directory in place
  --tree-path PATH   initialize an explicit tree checkout path
  --tree-mode MODE   dedicated or shared (default: dedicated)
  --help             show this help message`;

function configureBootstrapCommand(command: Command): void {
  command
    .option("--here", "initialize the current directory in place")
    .option("--tree-path <path>", "initialize an explicit tree checkout path")
    .option("--tree-mode <mode>", "dedicated or shared");
}

function readBootstrapOptions(command: Command): BootstrapOptions {
  const options = command.opts() as Record<string, string | boolean | undefined>;
  return {
    here: options.here === true,
    treeMode: options.treeMode as "dedicated" | "shared" | undefined,
    treePath: typeof options.treePath === "string" ? options.treePath : undefined,
  };
}

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

export function bootstrapTreeRoot(
  targetRoot: string,
  options?: BootstrapOptions,
): BootstrapSummary {
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
  writeIfMissing(
    join(targetRoot, ".first-tree", "agent-templates", "developer.yaml"),
    renderDeveloperAgentTemplate(),
  );
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

function runBootstrapCommand(context: CommandContext): void {
  try {
    const options = readBootstrapOptions(context.command);
    const targetRoot = options.here
      ? process.cwd()
      : options.treePath
        ? resolve(process.cwd(), options.treePath)
        : (() => {
            throw new Error("Pass either `--here` or `--tree-path <path>`.");
          })();
    const summary = bootstrapTreeRoot(targetRoot, options);
    const hookMessages = formatAgentContextHookMessages(ensureAgentContextHooks(summary.root));

    if (context.options.json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    console.log("Context Tree Bootstrap\n");
    console.log(`  Tree root:      ${summary.root}`);
    console.log(`  Tree repo name: ${summary.treeRepoName}`);
    console.log(`  Tree mode:      ${summary.treeMode}`);
    console.log("");
    console.log(`  Ensured ${join(summary.root, "NODE.md")}`);
    console.log(`  Ensured ${join(summary.root, "AGENTS.md")}`);
    console.log(`  Ensured ${join(summary.root, "members", "NODE.md")}`);
    console.log(`  Ensured ${join(summary.root, "members", "owner", "NODE.md")}`);
    console.log(
      `  ${describeTemplateWriteResult(
        validateWorkflowPath(summary.root),
        summary.tier0RuleLayer.validate,
      )}`,
    );
    for (const message of hookMessages) {
      console.log(`  ${message}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export const bootstrapCommand: SubcommandModule = {
  name: "bootstrap",
  alias: "",
  summary: "",
  description: "Bootstrap an explicit tree repo checkout.",
  action: runBootstrapCommand,
  configure: configureBootstrapCommand,
};
