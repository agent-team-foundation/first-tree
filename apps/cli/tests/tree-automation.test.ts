import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { installTreeAutomation } from "../src/commands/tree/automation.js";
import { autoMergeWorkflowPath, reviewEnforcerWorkflowPath } from "../src/commands/tree/rule-layer.js";
import { renderAutoMergeWorkflow, renderReviewEnforcerWorkflow } from "../src/commands/tree/tree-templates.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeTreeFixture(root: string, remoteUrl = "https://github.com/acme/context-tree.git"): void {
  mkdirSync(join(root, ".first-tree"), { recursive: true });
  writeFileSync(join(root, ".git"), "gitdir: /tmp/tree\n");
  writeFileSync(join(root, "AGENTS.md"), "# Agents\n");
  writeFileSync(join(root, "CLAUDE.md"), "# Claude\n");
  writeFileSync(
    join(root, ".first-tree", "tree.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      treeId: "context-tree",
      treeMode: "shared",
      treeRepoName: "context-tree",
      published: {
        remoteUrl,
      },
    })}\n`,
  );
}

function encodeContent(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("installTreeAutomation", () => {
  it("writes Tier 2 workflow templates locally and stops at stage A until they land on default branch", () => {
    const root = makeTempDir("first-tree-automation-stage-a-");
    writeTreeFixture(root);

    const calls: string[] = [];
    const runner = (command: string, args: string[]) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (command === "gh" && args[0] === "api" && args[1] === "repos/acme/context-tree") {
        return JSON.stringify({ default_branch: "main" });
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    };

    const summary = installTreeAutomation(root, { dryRun: false, tier: 2 }, runner);

    expect(summary.stage).toBe("write_rule_layer");
    expect(summary.repoSlug).toBe("acme/context-tree");
    expect(summary.workflowFiles.map((item) => item.status)).toEqual(["written", "written"]);
    expect(readFileSync(autoMergeWorkflowPath(root), "utf8")).toContain("# first-tree-template-version: 1");
    expect(readFileSync(reviewEnforcerWorkflowPath(root), "utf8")).toContain("# first-tree-template-version: 1");
    expect(calls[0]).toBe("gh api repos/acme/context-tree");
    expect(calls).toContain("gh api repos/acme/context-tree/installation");
  });

  it("prints a ruleset-create command once both workflows are present on the default branch", () => {
    const root = makeTempDir("first-tree-automation-stage-b-");
    writeTreeFixture(root);
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(autoMergeWorkflowPath(root), renderAutoMergeWorkflow());
    writeFileSync(reviewEnforcerWorkflowPath(root), renderReviewEnforcerWorkflow());

    const runner = (command: string, args: string[]) => {
      const key = `${command} ${args.join(" ")}`;
      switch (key) {
        case "gh api repos/acme/context-tree":
          return JSON.stringify({ default_branch: "main" });
        case "gh api repos/acme/context-tree/installation":
          throw new Error("not installed");
        case "gh api repos/acme/context-tree/contents/.github/workflows/auto-merge.yml?ref=main --jq .content":
          return encodeContent(renderAutoMergeWorkflow());
        case "gh api repos/acme/context-tree/contents/.github/workflows/review-enforcer.yml?ref=main --jq .content":
          return encodeContent(renderReviewEnforcerWorkflow());
        case "gh api repos/acme/context-tree/rulesets?includes_parents=false":
          return "[]";
        default:
          throw new Error(`unexpected command: ${key}`);
      }
    };

    const summary = installTreeAutomation(root, { dryRun: true, tier: 2 }, runner);

    expect(summary.stage).toBe("create_ruleset");
    expect(summary.nextCommands[0]).toContain("gh api repos/acme/context-tree/rulesets --method POST");
    expect(summary.nextCommands[0]).toContain('"enforcement": "evaluate"');
    expect(summary.nextCommands[0]).toContain('"required_approving_review_count": 1');
    expect(summary.nextCommands[0]).toContain('"context": "gate"');
    expect(summary.warnings.some((warning) => warning.includes("Enterprise-only"))).toBe(true);
  });

  it("prints an activate command when the expected ruleset is in evaluate mode", () => {
    const root = makeTempDir("first-tree-automation-stage-c-");
    writeTreeFixture(root);
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(autoMergeWorkflowPath(root), renderAutoMergeWorkflow());
    writeFileSync(reviewEnforcerWorkflowPath(root), renderReviewEnforcerWorkflow());

    const evaluateRuleset = {
      id: 42,
      name: "first-tree owners gate",
      target: "branch",
      enforcement: "evaluate",
      bypass_actors: [],
      conditions: {
        ref_name: {
          include: ["refs/heads/main"],
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
      ],
    };

    const runner = (command: string, args: string[]) => {
      const key = `${command} ${args.join(" ")}`;
      switch (key) {
        case "gh api repos/acme/context-tree":
          return JSON.stringify({ default_branch: "main" });
        case "gh api repos/acme/context-tree/installation":
          return JSON.stringify({ id: 7 });
        case "gh api repos/acme/context-tree/contents/.github/workflows/auto-merge.yml?ref=main --jq .content":
          return encodeContent(renderAutoMergeWorkflow());
        case "gh api repos/acme/context-tree/contents/.github/workflows/review-enforcer.yml?ref=main --jq .content":
          return encodeContent(renderReviewEnforcerWorkflow());
        case "gh api repos/acme/context-tree/rulesets?includes_parents=false":
          return JSON.stringify([evaluateRuleset]);
        default:
          throw new Error(`unexpected command: ${key}`);
      }
    };

    const summary = installTreeAutomation(root, { dryRun: true, tier: 2 }, runner);

    expect(summary.stage).toBe("activate_ruleset");
    expect(summary.ruleset).toEqual({
      enforcement: "evaluate",
      id: 42,
      name: "first-tree owners gate",
    });
    expect(summary.nextCommands[0]).toContain("gh api repos/acme/context-tree/rulesets/42 --method PUT");
    expect(summary.nextCommands[0]).toContain('"enforcement": "active"');
  });

  it("reports configured once the expected ruleset is already active", () => {
    const root = makeTempDir("first-tree-automation-configured-");
    writeTreeFixture(root);
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(autoMergeWorkflowPath(root), renderAutoMergeWorkflow());
    writeFileSync(reviewEnforcerWorkflowPath(root), renderReviewEnforcerWorkflow());

    const activeRuleset = {
      id: 42,
      name: "first-tree owners gate",
      target: "branch",
      enforcement: "active",
    };

    const runner = (command: string, args: string[]) => {
      const key = `${command} ${args.join(" ")}`;
      switch (key) {
        case "gh api repos/acme/context-tree":
          return JSON.stringify({ default_branch: "main" });
        case "gh api repos/acme/context-tree/installation":
          return JSON.stringify({ id: 7 });
        case "gh api repos/acme/context-tree/contents/.github/workflows/auto-merge.yml?ref=main --jq .content":
          return encodeContent(renderAutoMergeWorkflow());
        case "gh api repos/acme/context-tree/contents/.github/workflows/review-enforcer.yml?ref=main --jq .content":
          return encodeContent(renderReviewEnforcerWorkflow());
        case "gh api repos/acme/context-tree/rulesets?includes_parents=false":
          return JSON.stringify([activeRuleset]);
        default:
          throw new Error(`unexpected command: ${key}`);
      }
    };

    const summary = installTreeAutomation(root, { dryRun: true, tier: 2 }, runner);

    expect(summary.stage).toBe("configured");
    expect(summary.nextCommands).toHaveLength(0);
    expect(summary.ruleset).toEqual({
      enforcement: "active",
      id: 42,
      name: "first-tree owners gate",
    });
  });

  it("rejects running from a source repo without an explicit tree path", () => {
    const root = makeTempDir("first-tree-automation-source-");
    writeFileSync(join(root, ".git"), "gitdir: /tmp/source\n");
    writeFileSync(
      join(root, "AGENTS.md"),
      [
        "<!-- BEGIN FIRST-TREE-SOURCE-INTEGRATION -->",
        "FIRST-TREE-TREE-REPO: `context-tree`",
        "FIRST-TREE-BINDING-MODE: `shared-source`",
        "<!-- END FIRST-TREE-SOURCE-INTEGRATION -->",
      ].join("\n"),
    );

    expect(() => installTreeAutomation(root, { dryRun: true, tier: 2 })).toThrow(
      /only has source\/workspace integration installed/i,
    );
  });
});
