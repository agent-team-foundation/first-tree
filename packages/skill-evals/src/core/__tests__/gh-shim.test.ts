import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { readEvents } from "../events.js";
import { createRunPaths } from "../paths.js";
import { createGhShim } from "../shims/gh.js";

function createShim(caseId: string): { repoRoot: string; ghPath: string; eventsPath: string; workspacePath: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), "skill-evals-gh-shim-test-"));
  const packageRoot = join(repoRoot, "packages", "skill-evals");
  mkdirSync(packageRoot, { recursive: true });
  const paths = createRunPaths({ caseId, packageRoot, startedAt: "2026-06-30T00:00:00.000Z" });
  createGhShim(paths);
  return {
    repoRoot,
    ghPath: join(paths.binDir, "gh"),
    eventsPath: paths.eventsPath,
    workspacePath: paths.workspacePath,
  };
}

describe("gh eval shim", () => {
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
                dismiss_stale_reviews_on_push: false,
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

  it("serves CODEOWNERS contents from the pushed local origin", () => {
    const shim = createShim("unbound-github-tree-governance-bootstrap");
    try {
      const treePath = join(shim.workspacePath, "context-tree");
      const originPath = join(shim.workspacePath, "context-tree-origin.git");
      mkdirSync(join(treePath, ".github"), { recursive: true });
      writeFileSync(join(treePath, ".github", "CODEOWNERS"), "* @agent-team-foundation/context-maintainers\n", "utf8");
      for (const args of [
        ["init", "--initial-branch=main"],
        ["config", "user.email", "eval@example.invalid"],
        ["config", "user.name", "First Tree Eval"],
        ["config", "commit.gpgsign", "false"],
        ["add", "."],
        ["commit", "-m", "chore: add codeowners"],
      ]) {
        expect(spawnSync("git", args, { cwd: treePath, encoding: "utf8" }).status).toBe(0);
      }
      expect(
        spawnSync("git", ["clone", "--bare", treePath, originPath], { cwd: shim.workspacePath, encoding: "utf8" })
          .status,
      ).toBe(0);
      expect(
        spawnSync("git", ["remote", "add", "origin", originPath], { cwd: treePath, encoding: "utf8" }).status,
      ).toBe(0);

      const result = spawnSync(
        shim.ghPath,
        ["api", "repos/agent-team-foundation/context-tree/contents/.github/CODEOWNERS?ref=main"],
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
      expect(Buffer.from(result.stdout.trim(), "base64").toString("utf8")).toBe(
        "* @agent-team-foundation/context-maintainers\n",
      );
    } finally {
      rmSync(shim.repoRoot, { force: true, recursive: true });
    }
  });

  it("rejects ruleset payloads with wrong governance values", () => {
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
                require_code_owner_review: false,
                require_last_push_approval: true,
                required_approving_review_count: 0,
                required_review_thread_resolution: true,
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

  it("rejects ruleset payloads missing create-only semantics", () => {
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
                  dismiss_stale_reviews_on_push: false,
                  require_code_owner_review: true,
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
          "malformed-conditions.json",
          {
            conditions: { ref_name: { include: ["~DEFAULT_BRANCH", "refs/heads/main"] } },
            enforcement: "active",
            name: "First Tree Context Repo branch rules",
            rules: [
              { type: "non_fast_forward" },
              {
                parameters: {
                  dismiss_stale_reviews_on_push: false,
                  require_code_owner_review: true,
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
      const result = spawnSync(shim.ghPath, ["api", "repos/agent-team-foundation/context-tree", "--method=DELETE"], {
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

  it("simulates fail-closed owner resolution for recovery governance calls", () => {
    const shim = createShim("unbound-github-governance-fail-closed");
    try {
      const result = spawnSync(shim.ghPath, ["api", "repos/$repo/teams?per_page=100"], {
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
      expect(result.stderr).toContain("No qualifying visible non-author team");
      expect(readEvents(shim.eventsPath)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            argv: ["api", "repos/$repo/teams?per_page=100"],
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
