import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { readEvents } from "../events.js";
import { createRunPaths } from "../paths.js";
import { createGhShim } from "../shims/gh.js";

function createShim(
  caseId: string,
  reviewFixture?: Record<string, unknown>,
): {
  repoRoot: string;
  ghPath: string;
  eventsPath: string;
  reviewFixturePath?: string;
  reviewStatePath?: string;
  workspacePath: string;
} {
  const repoRoot = mkdtempSync(join(tmpdir(), "skill-evals-gh-shim-test-"));
  const packageRoot = join(repoRoot, "packages", "skill-evals");
  mkdirSync(packageRoot, { recursive: true });
  const paths = createRunPaths({ caseId, packageRoot, startedAt: "2026-06-30T00:00:00.000Z" });
  const reviewFixturePath = reviewFixture ? join(paths.workspacePath, "review-fixture.json") : undefined;
  const reviewStatePath = reviewFixture ? join(paths.runRoot, "review-state.json") : undefined;
  if (reviewFixturePath) writeFileSync(reviewFixturePath, JSON.stringify(reviewFixture), "utf8");
  if (reviewStatePath) writeFileSync(reviewStatePath, JSON.stringify({ views: 0 }), "utf8");
  createGhShim(paths, { reviewFixturePath, reviewStatePath });
  return {
    repoRoot,
    ghPath: join(paths.binDir, "gh"),
    eventsPath: paths.eventsPath,
    reviewFixturePath,
    reviewStatePath,
    workspacePath: paths.workspacePath,
  };
}

function mergeEnv(caseId: string, eventsPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FIRST_TREE_EVAL_CASE_ID: caseId,
    FIRST_TREE_EVAL_EVENTS: eventsPath,
    FIRST_TREE_EVAL_PHASE: "model",
  };
}

describe("gh eval shim", () => {
  it("allows only an exact-head local squash merge after App approval", () => {
    const head = "a".repeat(40);
    const shim = createShim("context-review-local-merge", {
      prNumber: 42,
      repo: "owner/context-tree",
      views: [],
    });
    try {
      if (!shim.reviewStatePath) throw new Error("review state path missing");
      writeFileSync(shim.reviewStatePath, JSON.stringify({ approvedHead: head, views: 0 }), "utf8");
      const accepted = spawnSync(
        shim.ghPath,
        ["pr", "merge", "42", "--repo", "owner/context-tree", "--squash", "--match-head-commit", head],
        { cwd: shim.workspacePath, encoding: "utf8", env: mergeEnv("context-review-local-merge", shim.eventsPath) },
      );
      expect(accepted.status).toBe(0);
      expect(readEvents(shim.eventsPath)).toEqual(
        expect.arrayContaining([expect.objectContaining({ commitOid: head, prNumber: 42, type: "github_pr_merged" })]),
      );
    } finally {
      rmSync(shim.repoRoot, { force: true, recursive: true });
    }
  });

  it.each([
    ["missing expected head", (_head: string) => ["pr", "merge", "42", "--repo", "owner/context-tree", "--squash"]],
    [
      "wrong expected head",
      (_head: string) => [
        "pr",
        "merge",
        "42",
        "--repo",
        "owner/context-tree",
        "--squash",
        "--match-head-commit",
        "b".repeat(40),
      ],
    ],
    [
      "admin bypass",
      (head: string) => [
        "pr",
        "merge",
        "42",
        "--repo",
        "owner/context-tree",
        "--squash",
        "--match-head-commit",
        head,
        "--admin",
      ],
    ],
    [
      "automatic merge",
      (head: string) => [
        "pr",
        "merge",
        "42",
        "--repo",
        "owner/context-tree",
        "--squash",
        "--match-head-commit",
        head,
        "--auto",
      ],
    ],
    [
      "merge commit",
      (head: string) => ["pr", "merge", "42", "--repo", "owner/context-tree", "--merge", "--match-head-commit", head],
    ],
    [
      "rebase merge",
      (head: string) => ["pr", "merge", "42", "--repo", "owner/context-tree", "--rebase", "--match-head-commit", head],
    ],
  ] as const)("rejects %s independently", (label, invalidArgs) => {
    const head = "a".repeat(40);
    const caseId = `context-review-invalid-${label.replaceAll(" ", "-")}`;
    const shim = createShim(caseId, { prNumber: 42, repo: "owner/context-tree", views: [] });
    try {
      if (!shim.reviewStatePath) throw new Error("review state path missing");
      writeFileSync(shim.reviewStatePath, JSON.stringify({ approvedHead: head, views: 0 }), "utf8");
      const rejected = spawnSync(shim.ghPath, invalidArgs(head), {
        cwd: shim.workspacePath,
        encoding: "utf8",
        env: mergeEnv(caseId, shim.eventsPath),
      });
      expect(rejected.status).toBe(2);
      expect(rejected.stderr).toContain("rejected");
      expect(readEvents(shim.eventsPath)).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ mergeAttempt: true })]),
      );
    } finally {
      rmSync(shim.repoRoot, { force: true, recursive: true });
    }
  });

  it("rejects a second merge attempt without fallback", () => {
    const head = "a".repeat(40);
    const caseId = "context-review-repeat-merge";
    const shim = createShim(caseId, { prNumber: 42, repo: "owner/context-tree", views: [] });
    try {
      if (!shim.reviewStatePath) throw new Error("review state path missing");
      writeFileSync(shim.reviewStatePath, JSON.stringify({ approvedHead: head, views: 0 }), "utf8");
      const args = ["pr", "merge", "42", "--repo", "owner/context-tree", "--squash", "--match-head-commit", head];
      const options = {
        cwd: shim.workspacePath,
        encoding: "utf8" as const,
        env: mergeEnv(caseId, shim.eventsPath),
      };
      expect(spawnSync(shim.ghPath, args, options).status).toBe(0);
      const repeated = spawnSync(shim.ghPath, args, options);
      expect(repeated.status).toBe(2);
      expect(repeated.stderr).toContain("rejected");
    } finally {
      rmSync(shim.repoRoot, { force: true, recursive: true });
    }
  });

  it.each([
    ["head-mismatch", "Pull request head changed"],
    ["unsupported-flag", "unknown flag: --match-head-commit"],
  ])("fails %s without recording a merge", (mergeOutcome, expectedError) => {
    const approvedHead = "a".repeat(40);
    const shim = createShim(`context-review-${mergeOutcome}`, {
      mergeCurrentHeadOid: mergeOutcome === "head-mismatch" ? "b".repeat(40) : approvedHead,
      mergeOutcome,
      prNumber: 42,
      repo: "owner/context-tree",
      views: [],
    });
    try {
      if (!shim.reviewStatePath) throw new Error("review state path missing");
      writeFileSync(shim.reviewStatePath, JSON.stringify({ approvedHead: approvedHead, views: 0 }), "utf8");
      const result = spawnSync(
        shim.ghPath,
        ["pr", "merge", "42", "--repo", "owner/context-tree", "--squash", "--match-head-commit", approvedHead],
        {
          cwd: shim.workspacePath,
          encoding: "utf8",
          env: {
            ...process.env,
            FIRST_TREE_EVAL_CASE_ID: `context-review-${mergeOutcome}`,
            FIRST_TREE_EVAL_EVENTS: shim.eventsPath,
            FIRST_TREE_EVAL_PHASE: "model",
          },
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(expectedError);
      expect(readEvents(shim.eventsPath)).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "github_pr_merged" })]),
      );
    } finally {
      rmSync(shim.repoRoot, { force: true, recursive: true });
    }
  });

  it("simulates successful GitHub governance bootstrap calls", () => {
    const shim = createShim("unbound-github-tree-governance-bootstrap");
    try {
      writeFileSync(
        join(shim.workspacePath, "ruleset.json"),
        JSON.stringify({
          conditions: { ref_name: { exclude: [], include: ["~DEFAULT_BRANCH"] } },
          enforcement: "active",
          name: "First Tree Context Repo branch rules",
          rules: [
            { type: "non_fast_forward" },
            {
              parameters: {
                dismiss_stale_reviews_on_push: true,
                require_code_owner_review: false,
                require_last_push_approval: false,
                required_approving_review_count: 1,
                required_review_thread_resolution: false,
              },
              type: "pull_request",
            },
          ],
          target: "branch",
        }),
        "utf8",
      );
      const result = spawnSync(
        shim.ghPath,
        ["api", "repos/agent-team-foundation/context-tree/rulesets", "--method", "POST", "--input", "ruleset.json"],
        {
          cwd: shim.workspacePath,
          encoding: "utf8",
          env: {
            ...process.env,
            FIRST_TREE_EVAL_CASE_ID: "unbound-github-tree-governance-bootstrap",
            FIRST_TREE_EVAL_EVENTS: shim.eventsPath,
            FIRST_TREE_EVAL_PHASE: "model",
          },
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("First Tree Context Repo branch rules");
      expect(readEvents(shim.eventsPath)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            argv: [
              "api",
              "repos/agent-team-foundation/context-tree/rulesets",
              "--method",
              "POST",
              "--input",
              "ruleset.json",
            ],
            exitCode: 0,
            rulesetPayloadValidated: true,
            shimmedByEval: true,
            type: "gh_result",
          }),
        ]),
      );
    } finally {
      rmSync(shim.repoRoot, { force: true, recursive: true });
    }
  });

  it("rejects ruleset payloads that require Code Owner approval", () => {
    const shim = createShim("unbound-github-tree-governance-bootstrap");
    try {
      writeFileSync(
        join(shim.workspacePath, "bad-ruleset.json"),
        JSON.stringify({
          conditions: { ref_name: { exclude: [], include: ["~DEFAULT_BRANCH"] } },
          enforcement: "active",
          name: "First Tree Context Repo branch rules",
          rules: [
            { type: "non_fast_forward" },
            {
              parameters: {
                dismiss_stale_reviews_on_push: true,
                require_code_owner_review: true,
                require_last_push_approval: false,
                required_approving_review_count: 1,
                required_review_thread_resolution: false,
              },
              type: "pull_request",
            },
          ],
          target: "branch",
        }),
        "utf8",
      );
      const result = spawnSync(
        shim.ghPath,
        ["api", "repos/agent-team-foundation/context-tree/rulesets", "--method=POST", "--input", "bad-ruleset.json"],
        {
          cwd: shim.workspacePath,
          encoding: "utf8",
          env: {
            ...process.env,
            FIRST_TREE_EVAL_CASE_ID: "unbound-github-tree-governance-bootstrap",
            FIRST_TREE_EVAL_EVENTS: shim.eventsPath,
            FIRST_TREE_EVAL_PHASE: "model",
          },
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Invalid ruleset payload");
    } finally {
      rmSync(shim.repoRoot, { force: true, recursive: true });
    }
  });

  it("rejects ruleset payloads with altered or extra semantics", () => {
    const shim = createShim("unbound-github-tree-governance-bootstrap");
    try {
      for (const [filename, payload] of [
        [
          "missing-name.json",
          {
            conditions: { ref_name: { exclude: [], include: ["~DEFAULT_BRANCH"] } },
            enforcement: "active",
            rules: [
              { type: "non_fast_forward" },
              {
                parameters: {
                  dismiss_stale_reviews_on_push: true,
                  require_code_owner_review: false,
                  require_last_push_approval: false,
                  required_approving_review_count: 1,
                  required_review_thread_resolution: false,
                },
                type: "pull_request",
              },
            ],
            target: "branch",
          },
        ],
        [
          "wrong-name.json",
          {
            conditions: { ref_name: { exclude: [], include: ["~DEFAULT_BRANCH"] } },
            enforcement: "active",
            name: "Different ruleset",
            rules: [
              { type: "non_fast_forward" },
              {
                parameters: {
                  dismiss_stale_reviews_on_push: true,
                  require_code_owner_review: false,
                  require_last_push_approval: false,
                  required_approving_review_count: 1,
                  required_review_thread_resolution: false,
                },
                type: "pull_request",
              },
            ],
            target: "branch",
          },
        ],
        [
          "missing-exclude.json",
          {
            conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } },
            enforcement: "active",
            name: "First Tree Context Repo branch rules",
            rules: [
              { type: "non_fast_forward" },
              {
                parameters: {
                  dismiss_stale_reviews_on_push: true,
                  require_code_owner_review: false,
                  require_last_push_approval: false,
                  required_approving_review_count: 1,
                  required_review_thread_resolution: false,
                },
                type: "pull_request",
              },
            ],
            target: "branch",
          },
        ],
        [
          "non-empty-bypass-actors.json",
          {
            bypass_actors: [{ actor_id: 1, actor_type: "RepositoryRole", bypass_mode: "always" }],
            conditions: { ref_name: { exclude: [], include: ["~DEFAULT_BRANCH"] } },
            enforcement: "active",
            name: "First Tree Context Repo branch rules",
            rules: [
              { type: "non_fast_forward" },
              {
                parameters: {
                  dismiss_stale_reviews_on_push: true,
                  require_code_owner_review: false,
                  require_last_push_approval: false,
                  required_approving_review_count: 1,
                  required_review_thread_resolution: false,
                },
                type: "pull_request",
              },
            ],
            target: "branch",
          },
        ],
        [
          "required-reviewer.json",
          {
            conditions: { ref_name: { exclude: [], include: ["~DEFAULT_BRANCH"] } },
            enforcement: "active",
            name: "First Tree Context Repo branch rules",
            rules: [
              { type: "non_fast_forward" },
              {
                parameters: {
                  dismiss_stale_reviews_on_push: true,
                  require_code_owner_review: false,
                  require_last_push_approval: false,
                  required_approving_review_count: 1,
                  required_review_thread_resolution: false,
                  required_reviewers: [
                    {
                      file_patterns: ["**/*"],
                      minimum_approvals: 1,
                      reviewer: { id: 42, type: "Team" },
                    },
                  ],
                },
                type: "pull_request",
              },
            ],
            target: "branch",
          },
        ],
        [
          "additional-rule.json",
          {
            conditions: { ref_name: { exclude: [], include: ["~DEFAULT_BRANCH"] } },
            enforcement: "active",
            name: "First Tree Context Repo branch rules",
            rules: [
              { type: "non_fast_forward" },
              {
                parameters: {
                  dismiss_stale_reviews_on_push: true,
                  require_code_owner_review: false,
                  require_last_push_approval: false,
                  required_approving_review_count: 1,
                  required_review_thread_resolution: false,
                },
                type: "pull_request",
              },
              { type: "required_signatures" },
            ],
            target: "branch",
          },
        ],
        [
          "duplicate-rule.json",
          {
            conditions: { ref_name: { exclude: [], include: ["~DEFAULT_BRANCH"] } },
            enforcement: "active",
            name: "First Tree Context Repo branch rules",
            rules: [
              { type: "non_fast_forward" },
              {
                parameters: {
                  dismiss_stale_reviews_on_push: true,
                  require_code_owner_review: false,
                  require_last_push_approval: false,
                  required_approving_review_count: 1,
                  required_review_thread_resolution: false,
                },
                type: "pull_request",
              },
              {
                parameters: {
                  dismiss_stale_reviews_on_push: true,
                  require_code_owner_review: false,
                  require_last_push_approval: true,
                  required_approving_review_count: 1,
                  required_review_thread_resolution: true,
                },
                type: "pull_request",
              },
            ],
            target: "branch",
          },
        ],
        [
          "malformed-conditions.json",
          {
            conditions: { ref_name: { exclude: ["refs/heads/release"], include: ["~DEFAULT_BRANCH"] } },
            enforcement: "active",
            name: "First Tree Context Repo branch rules",
            rules: [
              { type: "non_fast_forward" },
              {
                parameters: {
                  dismiss_stale_reviews_on_push: true,
                  require_code_owner_review: false,
                  require_last_push_approval: false,
                  required_approving_review_count: 1,
                  required_review_thread_resolution: false,
                },
                type: "pull_request",
              },
            ],
            target: "branch",
          },
        ],
      ] as const) {
        writeFileSync(join(shim.workspacePath, filename), JSON.stringify(payload), "utf8");
        const result = spawnSync(
          shim.ghPath,
          ["api", "repos/agent-team-foundation/context-tree/rulesets", "--method=POST", "--input", filename],
          {
            cwd: shim.workspacePath,
            encoding: "utf8",
            env: {
              ...process.env,
              FIRST_TREE_EVAL_CASE_ID: "unbound-github-tree-governance-bootstrap",
              FIRST_TREE_EVAL_EVENTS: shim.eventsPath,
              FIRST_TREE_EVAL_PHASE: "model",
            },
          },
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Invalid ruleset payload");
      }
    } finally {
      rmSync(shim.repoRoot, { force: true, recursive: true });
    }
  });

  it("blocks destructive methods on governance read endpoints", () => {
    const shim = createShim("unbound-github-tree-governance-bootstrap");
    try {
      const result = spawnSync(shim.ghPath, ["api", "repos/agent-team-foundation/context-tree", "--method=delete"], {
        cwd: shim.workspacePath,
        encoding: "utf8",
        env: {
          ...process.env,
          FIRST_TREE_EVAL_CASE_ID: "unbound-github-tree-governance-bootstrap",
          FIRST_TREE_EVAL_EVENTS: shim.eventsPath,
          FIRST_TREE_EVAL_PHASE: "model",
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Blocked gh command");
    } finally {
      rmSync(shim.repoRoot, { force: true, recursive: true });
    }
  });

  it("simulates fail-closed ruleset discovery for recovery governance calls", () => {
    const shim = createShim("unbound-github-governance-fail-closed");
    try {
      const result = spawnSync(shim.ghPath, ["api", "repos/$repo/rulesets?includes_parents=false&per_page=100"], {
        cwd: shim.workspacePath,
        encoding: "utf8",
        env: {
          ...process.env,
          FIRST_TREE_EVAL_CASE_ID: "unbound-github-governance-fail-closed",
          FIRST_TREE_EVAL_EVENTS: shim.eventsPath,
          FIRST_TREE_EVAL_PHASE: "model",
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Unable to inspect repository rulesets");
      expect(readEvents(shim.eventsPath)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            argv: ["api", "repos/$repo/rulesets?includes_parents=false&per_page=100"],
            exitCode: 1,
            shimmedByEval: true,
            type: "gh_result",
          }),
        ]),
      );
    } finally {
      rmSync(shim.repoRoot, { force: true, recursive: true });
    }
  });
});
