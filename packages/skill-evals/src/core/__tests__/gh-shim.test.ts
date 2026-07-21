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
): { repoRoot: string; ghPath: string; eventsPath: string; reviewFixturePath?: string; workspacePath: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), "skill-evals-gh-shim-test-"));
  const packageRoot = join(repoRoot, "packages", "skill-evals");
  mkdirSync(packageRoot, { recursive: true });
  const paths = createRunPaths({ caseId, packageRoot, startedAt: "2026-06-30T00:00:00.000Z" });
  const reviewFixturePath = reviewFixture ? join(paths.workspacePath, "review-fixture.json") : undefined;
  if (reviewFixturePath) writeFileSync(reviewFixturePath, JSON.stringify(reviewFixture), "utf8");
  createGhShim(paths, { reviewFixturePath });
  return {
    repoRoot,
    ghPath: join(paths.binDir, "gh"),
    eventsPath: paths.eventsPath,
    reviewFixturePath,
    workspacePath: paths.workspacePath,
  };
}

describe("gh eval shim", () => {
  it("records only the narrow read-only local GitHub identity lookup", () => {
    const shim = createShim("context-review-github-identity", {
      prNumber: 42,
      repo: "owner/context-tree",
      reviewerLogin: "read-only-reviewer",
    });
    try {
      const env = {
        ...process.env,
        FIRST_TREE_EVAL_CASE_ID: "context-review-github-identity",
        FIRST_TREE_EVAL_EVENTS: shim.eventsPath,
        FIRST_TREE_EVAL_PHASE: "model",
      };
      const accepted = spawnSync(shim.ghPath, ["api", "user", "--jq", ".login"], {
        cwd: shim.workspacePath,
        encoding: "utf8",
        env,
      });
      expect(accepted.status).toBe(0);
      expect(accepted.stdout).toBe("read-only-reviewer\n");
      expect(readEvents(shim.eventsPath)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ login: "read-only-reviewer", type: "github_identity_read" }),
        ]),
      );

      const broad = spawnSync(shim.ghPath, ["api", "user"], {
        cwd: shim.workspacePath,
        encoding: "utf8",
        env,
      });
      expect(broad.status).toBe(2);
      expect(broad.stderr).toContain("narrow local GitHub identity read");
    } finally {
      rmSync(shim.repoRoot, { force: true, recursive: true });
    }
  });

  it("allows only a locally authenticated exact-head squash merge after App approval", () => {
    const head = "a".repeat(40);
    const shim = createShim("context-review-local-merge", {
      prNumber: 42,
      repo: "owner/context-tree",
      reviewHeadOid: head,
      views: [{ headRefOid: head, url: "https://github.com/owner/context-tree/pull/42" }],
    });
    try {
      if (!shim.reviewFixturePath) throw new Error("review fixture path missing");
      writeFileSync(`${shim.reviewFixturePath}.state`, JSON.stringify({ approvedHead: head, views: 0 }), "utf8");
      const env = {
        ...process.env,
        FIRST_TREE_EVAL_CASE_ID: "context-review-local-merge",
        FIRST_TREE_EVAL_EVENTS: shim.eventsPath,
        FIRST_TREE_EVAL_PHASE: "model",
      };
      const accepted = spawnSync(
        shim.ghPath,
        ["pr", "merge", "https://github.com/owner/context-tree/pull/42", "--squash", "--match-head-commit", head],
        { cwd: shim.workspacePath, encoding: "utf8", env },
      );
      expect(accepted.status).toBe(0);
      expect(readEvents(shim.eventsPath)).toEqual(
        expect.arrayContaining([expect.objectContaining({ commitOid: head, prNumber: 42, type: "github_pr_merged" })]),
      );

      const bypass = spawnSync(
        shim.ghPath,
        ["pr", "merge", "42", "--repo", "owner/context-tree", "--squash", "--match-head-commit", head, "--admin"],
        { cwd: shim.workspacePath, encoding: "utf8", env },
      );
      expect(bypass.status).toBe(2);
      expect(bypass.stderr).toContain("rejected");

      const successorHead = "b".repeat(40);
      writeFileSync(
        `${shim.reviewFixturePath}.state`,
        JSON.stringify({ approvedHead: head, currentHeadOid: successorHead, views: 0 }),
        "utf8",
      );
      const racedView = spawnSync(
        shim.ghPath,
        ["pr", "view", "42", "--repo", "owner/context-tree", "--json", "headRefOid"],
        { cwd: shim.workspacePath, encoding: "utf8", env },
      );
      expect(racedView.status).toBe(0);
      expect(JSON.parse(racedView.stdout)).toMatchObject({ headRefOid: successorHead });
      const racedMerge = spawnSync(
        shim.ghPath,
        ["pr", "merge", "https://github.com/owner/context-tree/pull/42", "--squash", "--match-head-commit", head],
        { cwd: shim.workspacePath, encoding: "utf8", env },
      );
      expect(racedMerge.status).toBe(2);
      expect(racedMerge.stderr).toContain("rejected");
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
  }, 15_000);

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
