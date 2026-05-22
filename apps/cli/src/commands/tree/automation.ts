import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { Command } from "commander";

import type { CommandContext, SubcommandModule } from "../types.js";
import { readSourceBindingContract } from "./binding-contract.js";
import {
  AUTO_MERGE_WORKFLOW_TEMPLATE_VERSION,
  autoMergeWorkflowPath,
  ensureTier2RuleLayer,
  REVIEW_ENFORCER_WORKFLOW_TEMPLATE_VERSION,
  reviewEnforcerWorkflowPath,
} from "./rule-layer.js";
import { parseGitHubRemoteUrl, readGitRemoteUrl, runCommand } from "./shared.js";
import { parseTemplateVersion } from "./template-write.js";
import { readTreeIdentityContract } from "./tree-identity.js";

const RULESET_NAME = "first-tree owners gate";
const FIRST_TREE_GATE_INSTALL_URL = "https://github.com/apps/first-tree-gate";

type AutomationTier = 2;

type AutomationOptions = {
  dryRun: boolean;
  tier: AutomationTier;
  treePath?: string;
};

type RulesetEnforcement = "active" | "disabled" | "evaluate";

type WorkflowInstallStatus = "custom" | "needs-upgrade" | "present" | "would-write" | "written";

type ManagedWorkflowSummary = {
  currentVersion: number | null;
  path: string;
  status: WorkflowInstallStatus;
};

type RepositoryRuleset = {
  bypass_actors?: unknown[];
  conditions?: unknown;
  enforcement: RulesetEnforcement;
  id: number;
  name: string;
  rules?: unknown[];
  target?: string;
};

export type TreeAutomationStage = "activate_ruleset" | "configured" | "create_ruleset" | "write_rule_layer";

export type TreeAutomationSummary = {
  appInstalled: boolean | null;
  defaultBranch?: string;
  dryRun: boolean;
  nextCommands: string[];
  repoSlug?: string;
  ruleset?: {
    enforcement: RulesetEnforcement;
    id: number;
    name: string;
  };
  stage: TreeAutomationStage;
  targetRoot: string;
  tier: AutomationTier;
  warnings: string[];
  workflowFiles: ManagedWorkflowSummary[];
};

type CommandRunner = (command: string, args: string[], cwd: string) => string;

type RepoMetadata = {
  defaultBranch: string;
  repoSlug: string;
};

type RemoteWorkflowState = "custom" | "current" | "missing" | "outdated";

type WorkflowDefinition = {
  name: "auto-merge" | "review-enforcer";
  path: string;
  templateVersion: number;
};

function configureInstallAutomationCommand(command: Command): void {
  command
    .option("--tier <number>", "automation tier to install (default: 2)", "2")
    .option("--tree-path <path>", "operate on a tree repo from another working directory")
    .option("--dry-run", "inspect state and print next steps without writing files");
}

function readInstallAutomationOptions(command: Command): AutomationOptions {
  const options = command.opts() as {
    dryRun?: boolean;
    tier?: string;
    treePath?: string;
  };

  if (options.tier !== "2") {
    throw new Error("Only `--tier 2` is supported right now.");
  }

  return {
    dryRun: options.dryRun === true,
    tier: 2,
    treePath: options.treePath,
  };
}

function formatSourceRepoError(targetRoot: string): string {
  const sourceBinding = readSourceBindingContract(targetRoot);
  const treeRepoName = sourceBinding?.treeRepoName;
  const examplePath = treeRepoName ? `../${treeRepoName}` : "../<tree-repo>";
  return `This repo only has source/workspace integration installed. Run this command against the tree repo instead, for example \`first-tree tree automation install --tier 2 --tree-path ${examplePath}\`.`;
}

function resolveAutomationTargetRoot(command: Command): string {
  const options = command.opts() as { treePath?: string };
  return options.treePath ? resolve(process.cwd(), options.treePath) : process.cwd();
}

function normalizeRulesetEnforcement(value: unknown): RulesetEnforcement | null {
  return value === "active" || value === "disabled" || value === "evaluate" ? value : null;
}

function readRepoMetadata(targetRoot: string, runner: CommandRunner): RepoMetadata | null {
  const remoteUrl = readTreeIdentityContract(targetRoot)?.publishedTreeUrl ?? readGitRemoteUrl(targetRoot);
  const parsed = remoteUrl ? parseGitHubRemoteUrl(remoteUrl) : null;
  if (parsed === null) {
    return null;
  }

  const repoSlug = `${parsed.owner}/${parsed.repo}`;
  const raw = runner("gh", ["api", `repos/${repoSlug}`], targetRoot);
  const parsedJson = JSON.parse(raw) as { default_branch?: unknown };
  if (typeof parsedJson.default_branch !== "string" || parsedJson.default_branch.length === 0) {
    throw new Error(`Could not determine the default branch for ${repoSlug}.`);
  }

  return {
    defaultBranch: parsedJson.default_branch,
    repoSlug,
  };
}

function decodeBase64Content(content: string): string {
  return Buffer.from(content.replaceAll("\n", ""), "base64").toString("utf8");
}

function readRemoteWorkflowState(
  targetRoot: string,
  repoSlug: string,
  defaultBranch: string,
  definition: WorkflowDefinition,
  runner: CommandRunner,
): RemoteWorkflowState {
  try {
    const rawContent = runner(
      "gh",
      [
        "api",
        `repos/${repoSlug}/contents/.github/workflows/${definition.name}.yml?ref=${defaultBranch}`,
        "--jq",
        ".content",
      ],
      targetRoot,
    );
    const currentVersion = parseTemplateVersionFromContent(decodeBase64Content(rawContent));
    if (currentVersion === null) {
      return "custom";
    }
    return currentVersion >= definition.templateVersion ? "current" : "outdated";
  } catch {
    return "missing";
  }
}

function parseTemplateVersionFromContent(content: string): number | null {
  const firstLine = content.replaceAll("\r\n", "\n").split("\n", 1)[0] ?? "";
  const match = firstLine.match(/^# first-tree-template-version:\s*(\d+)\s*$/u);
  return match ? Number(match[1]) : null;
}

function readLocalWorkflowStatus(definition: WorkflowDefinition, dryRun: boolean): ManagedWorkflowSummary {
  if (!existsSync(definition.path)) {
    return {
      currentVersion: null,
      path: definition.path,
      status: dryRun ? "would-write" : "written",
    };
  }

  const currentVersion = parseTemplateVersion(definition.path);
  if (currentVersion === null) {
    return {
      currentVersion: null,
      path: definition.path,
      status: "custom",
    };
  }

  if (currentVersion < definition.templateVersion) {
    return {
      currentVersion,
      path: definition.path,
      status: "needs-upgrade",
    };
  }

  return {
    currentVersion,
    path: definition.path,
    status: "present",
  };
}

function ensureLocalTier2RuleLayer(
  targetRoot: string,
  dryRun: boolean,
  workflows: readonly WorkflowDefinition[],
): ManagedWorkflowSummary[] {
  if (dryRun) {
    return workflows.map((definition) => readLocalWorkflowStatus(definition, true));
  }

  const results = ensureTier2RuleLayer(targetRoot);
  return [
    {
      currentVersion: parseTemplateVersion(workflows[0].path),
      path: workflows[0].path,
      status:
        results.autoMerge.kind === "written"
          ? "written"
          : results.autoMerge.kind === "needs-upgrade"
            ? "needs-upgrade"
            : results.autoMerge.kind === "skipped-existing-no-marker"
              ? "custom"
              : "present",
    },
    {
      currentVersion: parseTemplateVersion(workflows[1].path),
      path: workflows[1].path,
      status:
        results.reviewEnforcer.kind === "written"
          ? "written"
          : results.reviewEnforcer.kind === "needs-upgrade"
            ? "needs-upgrade"
            : results.reviewEnforcer.kind === "skipped-existing-no-marker"
              ? "custom"
              : "present",
    },
  ];
}

function listRulesets(targetRoot: string, repoSlug: string, runner: CommandRunner): RepositoryRuleset[] {
  const raw = runner("gh", ["api", `repos/${repoSlug}/rulesets?includes_parents=false`], targetRoot);
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }

  const rulesets: RepositoryRuleset[] = [];

  for (const value of parsed) {
    if (typeof value !== "object" || value === null) {
      continue;
    }

    const record = value as Record<string, unknown>;
    const id = typeof record.id === "number" ? record.id : null;
    const name = typeof record.name === "string" ? record.name : null;
    const enforcement = normalizeRulesetEnforcement(record.enforcement);

    if (id === null || name === null || enforcement === null) {
      continue;
    }

    rulesets.push({
      id,
      name,
      enforcement,
      ...(typeof record.target === "string" ? { target: record.target } : {}),
      conditions: record.conditions,
      ...(Array.isArray(record.rules) ? { rules: record.rules } : {}),
      ...(Array.isArray(record.bypass_actors) ? { bypass_actors: record.bypass_actors } : {}),
    });
  }

  return rulesets;
}

function detectAppInstallation(targetRoot: string, repoSlug: string, runner: CommandRunner): boolean | null {
  try {
    runner("gh", ["api", `repos/${repoSlug}/installation`], targetRoot);
    return true;
  } catch {
    return null;
  }
}

function buildRulesetDefinition(defaultBranch: string): Record<string, unknown> {
  return {
    name: RULESET_NAME,
    target: "branch",
    enforcement: "evaluate",
    conditions: {
      ref_name: {
        include: [`refs/heads/${defaultBranch}`],
        exclude: [],
      },
    },
    rules: [
      {
        type: "pull_request",
        parameters: {
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_approving_review_count: 1,
          required_review_thread_resolution: false,
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: [{ context: "gate" }, { context: "validate" }],
          strict_required_status_checks_policy: false,
        },
      },
    ],
  };
}

function formatJsonCommand(endpoint: string, payload: Record<string, unknown>): string {
  return [`gh api ${endpoint} --method POST --input - <<'JSON'`, JSON.stringify(payload, null, 2), "JSON"].join("\n");
}

function formatRulesetCreateCommand(repoSlug: string, defaultBranch: string): string {
  return formatJsonCommand(`repos/${repoSlug}/rulesets`, buildRulesetDefinition(defaultBranch));
}

function formatRulesetActivateCommand(repoSlug: string, ruleset: RepositoryRuleset, defaultBranch: string): string {
  const payload = {
    name: ruleset.name,
    target: ruleset.target ?? "branch",
    enforcement: "active",
    bypass_actors: ruleset.bypass_actors ?? [],
    conditions:
      typeof ruleset.conditions === "object" && ruleset.conditions !== null
        ? ruleset.conditions
        : buildRulesetDefinition(defaultBranch).conditions,
    rules:
      Array.isArray(ruleset.rules) && ruleset.rules.length > 0
        ? ruleset.rules
        : buildRulesetDefinition(defaultBranch).rules,
  };

  return [
    `gh api repos/${repoSlug}/rulesets/${ruleset.id} --method PUT --input - <<'JSON'`,
    JSON.stringify(payload, null, 2),
    "JSON",
  ].join("\n");
}

function printAutomationSummary(summary: TreeAutomationSummary): void {
  console.log("Context Tree Automation\n");
  console.log(`  Tree root:       ${summary.targetRoot}`);
  console.log(`  Tier:            ${summary.tier}`);
  console.log(`  Dry run:         ${summary.dryRun ? "yes" : "no"}`);
  console.log(`  Stage:           ${summary.stage}`);
  if (summary.repoSlug) {
    console.log(`  GitHub repo:     ${summary.repoSlug}`);
  }
  if (summary.defaultBranch) {
    console.log(`  Default branch:  ${summary.defaultBranch}`);
  }
  if (summary.ruleset) {
    console.log(`  Ruleset:         ${summary.ruleset.name} (#${summary.ruleset.id}, ${summary.ruleset.enforcement})`);
  }
  console.log("");
  console.log("  Workflows:");
  for (const workflow of summary.workflowFiles) {
    console.log(`    - ${workflow.path}: ${workflow.status}`);
  }
  if (summary.warnings.length > 0) {
    console.log("");
    console.log("Warnings:");
    for (const warning of summary.warnings) {
      console.log(`  - ${warning}`);
    }
  }
  if (summary.nextCommands.length > 0) {
    console.log("");
    console.log("Next commands:");
    for (const command of summary.nextCommands) {
      console.log("");
      console.log(command);
    }
  }
}

export function installTreeAutomation(
  targetRoot: string,
  options: AutomationOptions,
  runner: CommandRunner = runCommand,
): TreeAutomationSummary {
  if (readSourceBindingContract(targetRoot) !== undefined && readTreeIdentityContract(targetRoot) === undefined) {
    throw new Error(formatSourceRepoError(targetRoot));
  }

  const workflows: WorkflowDefinition[] = [
    {
      name: "auto-merge",
      path: autoMergeWorkflowPath(targetRoot),
      templateVersion: AUTO_MERGE_WORKFLOW_TEMPLATE_VERSION,
    },
    {
      name: "review-enforcer",
      path: reviewEnforcerWorkflowPath(targetRoot),
      templateVersion: REVIEW_ENFORCER_WORKFLOW_TEMPLATE_VERSION,
    },
  ];

  const workflowFiles = ensureLocalTier2RuleLayer(targetRoot, options.dryRun, workflows);
  const warnings: string[] = [];
  const nextCommands: string[] = [];

  const repoMetadata = (() => {
    try {
      return readRepoMetadata(targetRoot, runner);
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
      return null;
    }
  })();

  if (repoMetadata === null) {
    warnings.push(
      "Publish the tree repo to GitHub before enabling Tier 2 rulesets. Stage A can still prepare the workflow files locally.",
    );
    return {
      appInstalled: null,
      dryRun: options.dryRun,
      nextCommands,
      stage: "write_rule_layer",
      targetRoot,
      tier: options.tier,
      warnings,
      workflowFiles,
    };
  }

  const appInstalled = detectAppInstallation(targetRoot, repoMetadata.repoSlug, runner);
  if (appInstalled === null) {
    warnings.push(
      `Could not confirm whether the \`first-tree-gate\` GitHub App is installed on ${repoMetadata.repoSlug} with the current GitHub credentials. Before turning Tier 2 on, verify the installation manually: ${FIRST_TREE_GATE_INSTALL_URL}`,
    );
  }

  const remoteWorkflowStates = workflows.map((definition) =>
    readRemoteWorkflowState(targetRoot, repoMetadata.repoSlug, repoMetadata.defaultBranch, definition, runner),
  );
  const localWorkflowNeedsFollowUp = workflowFiles.some((workflow) =>
    ["custom", "needs-upgrade", "would-write", "written"].includes(workflow.status),
  );
  const remoteWorkflowNeedsFollowUp = remoteWorkflowStates.some((state) => state !== "current");

  if (localWorkflowNeedsFollowUp || remoteWorkflowNeedsFollowUp) {
    if (remoteWorkflowNeedsFollowUp) {
      warnings.push(
        "Merge `.github/workflows/auto-merge.yml` and `.github/workflows/review-enforcer.yml` onto the default branch before rerunning this command.",
      );
    }
    warnings.push(
      "If classic branch protection is still enabled on the same branch, remove it before activating the ruleset or GitHub will stack the old and new constraints.",
    );
    return {
      appInstalled,
      defaultBranch: repoMetadata.defaultBranch,
      dryRun: options.dryRun,
      nextCommands,
      repoSlug: repoMetadata.repoSlug,
      stage: "write_rule_layer",
      targetRoot,
      tier: options.tier,
      warnings,
      workflowFiles,
    };
  }

  const rulesets = listRulesets(targetRoot, repoMetadata.repoSlug, runner);
  const ruleset = rulesets.find((item) => item.name === RULESET_NAME) ?? null;

  if (ruleset === null) {
    warnings.push(
      "GitHub documents `enforcement: evaluate` as Enterprise-only. On non-Enterprise plans, the printed create command may fail and you may need a different rollout strategy for Tier 2.",
    );
    nextCommands.push(formatRulesetCreateCommand(repoMetadata.repoSlug, repoMetadata.defaultBranch));
    return {
      appInstalled,
      defaultBranch: repoMetadata.defaultBranch,
      dryRun: options.dryRun,
      nextCommands,
      repoSlug: repoMetadata.repoSlug,
      stage: "create_ruleset",
      targetRoot,
      tier: options.tier,
      warnings,
      workflowFiles,
    };
  }

  if (ruleset.enforcement !== "active") {
    if (ruleset.enforcement !== "evaluate") {
      warnings.push(
        `Ruleset ${RULESET_NAME} exists with enforcement=${ruleset.enforcement}. Review it before switching to active.`,
      );
    }
    warnings.push(
      "GitHub documents `enforcement: evaluate` as Enterprise-only. If your repo plan does not support it, confirm the fallback rollout before activating the ruleset.",
    );
    nextCommands.push(formatRulesetActivateCommand(repoMetadata.repoSlug, ruleset, repoMetadata.defaultBranch));
    return {
      appInstalled,
      defaultBranch: repoMetadata.defaultBranch,
      dryRun: options.dryRun,
      nextCommands,
      repoSlug: repoMetadata.repoSlug,
      ruleset: {
        enforcement: ruleset.enforcement,
        id: ruleset.id,
        name: ruleset.name,
      },
      stage: "activate_ruleset",
      targetRoot,
      tier: options.tier,
      warnings,
      workflowFiles,
    };
  }

  return {
    appInstalled,
    defaultBranch: repoMetadata.defaultBranch,
    dryRun: options.dryRun,
    nextCommands,
    repoSlug: repoMetadata.repoSlug,
    ruleset: {
      enforcement: ruleset.enforcement,
      id: ruleset.id,
      name: ruleset.name,
    },
    stage: "configured",
    targetRoot,
    tier: options.tier,
    warnings,
    workflowFiles,
  };
}

function runInstallAutomationCommand(context: CommandContext): void {
  try {
    const targetRoot = resolveAutomationTargetRoot(context.command);
    const summary = installTreeAutomation(targetRoot, readInstallAutomationOptions(context.command));

    if (context.options.json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    printAutomationSummary(summary);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export const automationSubcommands: SubcommandModule[] = [
  {
    name: "install",
    alias: "",
    summary: "",
    description: "Install or inspect Context Tree GitHub automation.",
    action: runInstallAutomationCommand,
    configure: configureInstallAutomationCommand,
  },
];
