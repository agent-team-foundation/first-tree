import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import { automationSubcommands, installTreeAutomation } from "../src/commands/tree/automation.js";
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

function makeAutomationCommand(args: string[]): Command {
  const [subcommand] = automationSubcommands;
  if (!subcommand) throw new Error("missing automation install subcommand");

  const command = new Command("install");
  command.exitOverride();
  subcommand.configure?.(command);
  command.parse(["node", "test", ...args], { from: "node" });
  return command;
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

  it("reports dry-run local workflow statuses before the tree is published", () => {
    const root = makeTempDir("first-tree-automation-dry-local-");

    let summary = installTreeAutomation(root, { dryRun: true, tier: 2 });
    expect(summary.stage).toBe("write_rule_layer");
    expect(summary.workflowFiles.map((item) => item.status)).toEqual(["would-write", "would-write"]);
    expect(summary.warnings.some((warning) => warning.includes("Publish the tree repo"))).toBe(true);

    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(autoMergeWorkflowPath(root), "name: custom\n");
    writeFileSync(reviewEnforcerWorkflowPath(root), "# first-tree-template-version: 0\nname: old\n");

    summary = installTreeAutomation(root, { dryRun: true, tier: 2 });
    expect(summary.workflowFiles).toEqual([
      expect.objectContaining({ currentVersion: null, status: "custom" }),
      expect.objectContaining({ currentVersion: 0, status: "needs-upgrade" }),
    ]);
  });

  it("keeps local preparation as stage A when GitHub repo metadata is malformed", () => {
    const root = makeTempDir("first-tree-automation-bad-metadata-");
    writeTreeFixture(root);
    const runner = (command: string, args: string[]) => {
      const key = `${command} ${args.join(" ")}`;
      if (key === "gh api repos/acme/context-tree") return JSON.stringify({ default_branch: "" });
      throw new Error(`unexpected command: ${key}`);
    };

    const summary = installTreeAutomation(root, { dryRun: true, tier: 2 }, runner);

    expect(summary.stage).toBe("write_rule_layer");
    expect(summary.repoSlug).toBeUndefined();
    expect(summary.warnings).toContain("Could not determine the default branch for acme/context-tree.");
  });

  it("requires follow-up when remote workflows are custom or outdated", () => {
    const root = makeTempDir("first-tree-automation-remote-custom-");
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
          return JSON.stringify({ id: 7 });
        case "gh api repos/acme/context-tree/contents/.github/workflows/auto-merge.yml?ref=main --jq .content":
          return encodeContent("name: custom\n");
        case "gh api repos/acme/context-tree/contents/.github/workflows/review-enforcer.yml?ref=main --jq .content":
          return encodeContent("# first-tree-template-version: 0\nname: old\n");
        default:
          throw new Error(`unexpected command: ${key}`);
      }
    };

    const summary = installTreeAutomation(root, { dryRun: true, tier: 2 }, runner);

    expect(summary.stage).toBe("write_rule_layer");
    expect(summary.warnings).toContain(
      "Merge `.github/workflows/auto-merge.yml` and `.github/workflows/review-enforcer.yml` onto the default branch before rerunning this command.",
    );
  });

  it("treats missing remote workflow content as follow-up work", () => {
    const root = makeTempDir("first-tree-automation-remote-missing-");
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
          return JSON.stringify({ id: 7 });
        case "gh api repos/acme/context-tree/contents/.github/workflows/auto-merge.yml?ref=main --jq .content":
        case "gh api repos/acme/context-tree/contents/.github/workflows/review-enforcer.yml?ref=main --jq .content":
          throw new Error("not found");
        default:
          throw new Error(`unexpected command: ${key}`);
      }
    };

    const summary = installTreeAutomation(root, { dryRun: true, tier: 2 }, runner);

    expect(summary.stage).toBe("write_rule_layer");
    expect(summary.warnings.some((warning) => warning.includes("classic branch protection"))).toBe(true);
  });

  it("prints an activation command with fallback payloads for disabled rulesets", () => {
    const root = makeTempDir("first-tree-automation-disabled-ruleset-");
    writeTreeFixture(root);
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(autoMergeWorkflowPath(root), renderAutoMergeWorkflow());
    writeFileSync(reviewEnforcerWorkflowPath(root), renderReviewEnforcerWorkflow());

    const disabledRuleset = {
      id: 77,
      name: "first-tree owners gate",
      target: "branch",
      enforcement: "disabled",
      conditions: null,
      rules: [],
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
          return JSON.stringify([
            "ignored",
            { id: "bad", name: "first-tree owners gate", enforcement: "active" },
            { id: 99, name: "other", enforcement: "evaluate" },
            disabledRuleset,
          ]);
        default:
          throw new Error(`unexpected command: ${key}`);
      }
    };

    const summary = installTreeAutomation(root, { dryRun: true, tier: 2 }, runner);

    expect(summary.stage).toBe("activate_ruleset");
    expect(summary.ruleset).toEqual({ enforcement: "disabled", id: 77, name: "first-tree owners gate" });
    expect(summary.warnings.some((warning) => warning.includes("enforcement=disabled"))).toBe(true);
    expect(summary.nextCommands[0]).toContain('"include": [\n        "refs/heads/main"\n      ]');
    expect(summary.nextCommands[0]).toContain('"required_status_checks"');
  });

  it("prints a create command when rulesets API returns a non-array payload", () => {
    const root = makeTempDir("first-tree-automation-ruleset-nonarray-");
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
          return JSON.stringify({ id: 7 });
        case "gh api repos/acme/context-tree/contents/.github/workflows/auto-merge.yml?ref=main --jq .content":
          return encodeContent(renderAutoMergeWorkflow());
        case "gh api repos/acme/context-tree/contents/.github/workflows/review-enforcer.yml?ref=main --jq .content":
          return encodeContent(renderReviewEnforcerWorkflow());
        case "gh api repos/acme/context-tree/rulesets?includes_parents=false":
          return JSON.stringify({ values: [] });
        default:
          throw new Error(`unexpected command: ${key}`);
      }
    };

    const summary = installTreeAutomation(root, { dryRun: true, tier: 2 }, runner);

    expect(summary.stage).toBe("create_ruleset");
    expect(summary.nextCommands[0]).toContain("repos/acme/context-tree/rulesets");
  });

  it("runs the exported install action in text and JSON modes", () => {
    const [subcommand] = automationSubcommands;
    if (!subcommand) throw new Error("missing automation install subcommand");
    const root = makeTempDir("first-tree-automation-action-");
    const originalCwd = process.cwd();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      process.chdir(root);
      const command = makeAutomationCommand(["--dry-run"]);

      subcommand.action({ command, options: { debug: false, json: false, quiet: false } });
      expect(logSpy.mock.calls.flat().join("\n")).toContain("Context Tree Automation");

      logSpy.mockClear();
      subcommand.action({ command, options: { debug: false, json: true, quiet: false } });
      const json = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
      expect(json.stage).toBe("write_rule_layer");
      expect(json.dryRun).toBe(true);
    } finally {
      logSpy.mockRestore();
      process.chdir(originalCwd);
    }
  });

  it("reports command option errors through the exported install action", () => {
    const [subcommand] = automationSubcommands;
    if (!subcommand) throw new Error("missing automation install subcommand");
    const command = makeAutomationCommand(["--tier", "1"]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const originalExitCode = process.exitCode;

    try {
      process.exitCode = undefined;
      subcommand.action({ command, options: { debug: false, json: false, quiet: false } });
      expect(errorSpy).toHaveBeenCalledWith("Only `--tier 2` is supported right now.");
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
      errorSpy.mockRestore();
    }
  });
});
