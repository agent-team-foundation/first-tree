import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { readEvents } from "../events.js";
import { createRunPaths } from "../paths.js";
import { createGhShim } from "../shims/gh.js";

const TEST_RUN_ID = "01900000-0000-7000-8000-000000000042";

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
  if (reviewFixturePath)
    writeFileSync(reviewFixturePath, JSON.stringify({ runId: TEST_RUN_ID, ...reviewFixture }), "utf8");
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

function mergeArgs(head: string): string[] {
  return [
    "api",
    "--method",
    "PUT",
    "repos/owner/context-tree/pulls/42/merge",
    "--raw-field",
    `sha=${head}`,
    "--raw-field",
    "merge_method=squash",
  ];
}

const reconcileArgs = ["api", "--method", "GET", "repos/owner/context-tree/pulls/42"];

function seedApprovedHead(reviewStatePath: string, approvedHead = "a".repeat(40)): void {
  writeFileSync(reviewStatePath, JSON.stringify({ approvedHead }), "utf8");
}

function markApproved(reviewStatePath: string, eventsPath: string, approvedHead = "a".repeat(40)): void {
  seedApprovedHead(reviewStatePath, approvedHead);
  const response = {
    data: { action: "APPROVE", reviewedHead: approvedHead },
    ok: true,
  };
  for (const event of [
    {
      action: "approve",
      phase: "model",
      prNumber: 42,
      repo: "owner/context-tree",
      reviewedHead: approvedHead,
      runId: TEST_RUN_ID,
      type: "context_review_submitted",
    },
    {
      argv: ["tree", "review", "--run", TEST_RUN_ID, "--event", "APPROVE", "--body-file", "review.md"],
      exitCode: 0,
      phase: "model",
      stdoutPreview: `${JSON.stringify(response)}\n`,
      type: "first_tree_result",
    },
  ]) {
    appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
  }
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
      markApproved(shim.reviewStatePath, shim.eventsPath);
      const accepted = spawnSync(shim.ghPath, mergeArgs(head), {
        cwd: shim.workspacePath,
        encoding: "utf8",
        env: mergeEnv("context-review-local-merge", shim.eventsPath),
      });
      expect(accepted.status).toBe(0);
      expect(readEvents(shim.eventsPath)).toEqual(
        expect.arrayContaining([expect.objectContaining({ commitOid: head, prNumber: 42, type: "github_pr_merged" })]),
      );
    } finally {
      rmSync(shim.repoRoot, { force: true, recursive: true });
    }
  });

  it.each([
    ["missing expected head", (_head: string) => mergeArgs("").filter((arg) => arg !== "sha=")],
    ["wrong method", (head: string) => mergeArgs(head).map((arg) => (arg === "PUT" ? "POST" : arg))],
    ["wrong endpoint", (head: string) => mergeArgs(head).map((arg) => (arg.endsWith("/merge") ? `${arg}/queue` : arg))],
    [
      "alternate merge method",
      (head: string) => mergeArgs(head).map((arg) => (arg === "merge_method=squash" ? "merge_method=merge" : arg)),
    ],
    ["extra field", (head: string) => [...mergeArgs(head), "--raw-field", "auto=true"]],
  ] as const)("rejects %s independently", (label, invalidArgs) => {
    const head = "a".repeat(40);
    const caseId = `context-review-invalid-${label.replaceAll(" ", "-")}`;
    const shim = createShim(caseId, { prNumber: 42, repo: "owner/context-tree", views: [] });
    try {
      if (!shim.reviewStatePath) throw new Error("review state path missing");
      markApproved(shim.reviewStatePath, shim.eventsPath);
      const rejected = spawnSync(shim.ghPath, invalidArgs(head), {
        cwd: shim.workspacePath,
        encoding: "utf8",
        env: mergeEnv(caseId, shim.eventsPath),
      });
      expect([1, 2]).toContain(rejected.status);
      expect(rejected.stderr).toMatch(/Blocked|rejected/u);
      expect(readEvents(shim.eventsPath)).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ mergeAttempt: true })]),
      );
    } finally {
      rmSync(shim.repoRoot, { force: true, recursive: true });
    }
  });

  it("blocks the high-level gh pr merge path that can enqueue automatically", () => {
    const shim = createShim("context-review-block-high-level-merge", {
      prNumber: 42,
      repo: "owner/context-tree",
      views: [],
    });
    try {
      const result = spawnSync(shim.ghPath, ["pr", "merge", "42", "--repo", "owner/context-tree", "--squash"], {
        cwd: shim.workspacePath,
        encoding: "utf8",
        env: mergeEnv("context-review-block-high-level-merge", shim.eventsPath),
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Blocked gh command");
      expect(readEvents(shim.eventsPath)).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ mergeAttempt: true })]),
      );
    } finally {
      rmSync(shim.repoRoot, { force: true, recursive: true });
    }
  });

  it("rejects a merge mutation before a successful App approval", () => {
    const head = "a".repeat(40);
    const shim = createShim("context-review-before-approval", {
      prNumber: 42,
      repo: "owner/context-tree",
      views: [],
    });
    try {
      if (!shim.reviewStatePath) throw new Error("review state path missing");
      seedApprovedHead(shim.reviewStatePath, head);
      const result = spawnSync(shim.ghPath, mergeArgs(head), {
        cwd: shim.workspacePath,
        encoding: "utf8",
        env: mergeEnv("context-review-before-approval", shim.eventsPath),
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("rejected");
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
      markApproved(shim.reviewStatePath, shim.eventsPath);
      const args = mergeArgs(head);
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
    ["head-mismatch", "HTTP 409", false, 0],
    ["api-unsupported", "HTTP 404", false, 0],
    ["queue-required", "HTTP 405", false, 0],
    ["transport-open", "connection reset", false, 0],
    ["transport-merged", "connection reset", true, 0],
    ["transport-unknown", "connection reset", false, 1],
  ] as const)("fails %s without retrying the merge and reconciles once", (mergeOutcome, expectedError, merged, reconcileStatus) => {
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
      markApproved(shim.reviewStatePath, shim.eventsPath, approvedHead);
      const result = spawnSync(shim.ghPath, mergeArgs(approvedHead), {
        cwd: shim.workspacePath,
        encoding: "utf8",
        env: {
          ...process.env,
          FIRST_TREE_EVAL_CASE_ID: `context-review-${mergeOutcome}`,
          FIRST_TREE_EVAL_EVENTS: shim.eventsPath,
          FIRST_TREE_EVAL_PHASE: "model",
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(expectedError);
      const reconciled = spawnSync(shim.ghPath, reconcileArgs, {
        cwd: shim.workspacePath,
        encoding: "utf8",
        env: mergeEnv(`context-review-${mergeOutcome}`, shim.eventsPath),
      });
      expect(reconciled.status).toBe(reconcileStatus);
      const events = readEvents(shim.eventsPath);
      if (merged) {
        expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "github_pr_merged" })]));
      } else {
        expect(events).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "github_pr_merged" })]));
      }
      expect(events.filter((event) => (event as { mergeAttempt?: boolean }).mergeAttempt === true)).toHaveLength(1);
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
