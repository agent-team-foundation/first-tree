import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { RunPaths } from "../../../core/types.js";
import { FIRST_TREE_SEED_GATE_CASES, FIRST_TREE_SEED_PERIODIC_CASES } from "../cases.js";
import { approvedSkeletonChatHistoryMarkdown } from "../fixture.js";
import { casePassed, deriveMetrics } from "../grader.js";
import { buildGrading } from "../summary.js";
import type { EvalMetrics, FirstTreeSeedEvalCase, FixtureValidation } from "../types.js";

function findCase(id: string): FirstTreeSeedEvalCase {
  const evalCase = [...FIRST_TREE_SEED_GATE_CASES, ...FIRST_TREE_SEED_PERIODIC_CASES].find(
    (candidate) => candidate.id === id,
  );
  if (!evalCase) throw new Error(`Missing test case ${id}`);
  return evalCase;
}

function baseMetrics(overrides: Partial<EvalMetrics> = {}): EvalMetrics {
  return {
    approvalRequestObserved: true,
    chatHistoryReadObserved: true,
    contextTreeChanged: false,
    contextTreeStatus: "",
    directBareSourceContentReadObserved: false,
    expectedResponseObserved: true,
    finalResponse: "domain skeleton ready for approval.",
    firstTreeArgv: [],
    forbiddenActionHits: [],
    forbiddenSideEffectHits: [],
    fixtureValidationOk: true,
    githubAppRequirementObserved: false,
    legacyHandoffObserved: false,
    singlePrBuildObserved: false,
    leafContentObserved: false,
    singlePrBuildRefusalObserved: false,
    runnerExitCode: 0,
    seedSkillFileReadObserved: true,
    skeletonObserved: true,
    sourceEvidenceReadObserved: true,
    sourceRepoChanged: false,
    sourceWorktreeAccessObserved: true,
    sourceWorktreeCreated: true,
    sourceWorktreeMaterializedObserved: true,
    treeInitObserved: false,
    treeInitWithContextTreeDirObserved: false,
    workspaceManifestReadObserved: true,
    writeSkillFileReadObserved: false,
    ...overrides,
  };
}

function baseRunPaths(workspacePath: string): RunPaths {
  return {
    binDir: join(workspacePath, "bin"),
    eventsPath: join(workspacePath, "events.jsonl"),
    gradingJsonPath: join(workspacePath, "grading.json"),
    modelEventsPath: join(workspacePath, ".first-tree-eval", "events.jsonl"),
    packageRoot: workspacePath,
    repoRoot: workspacePath,
    runRoot: workspacePath,
    shellEnvDir: join(workspacePath, "shell-env"),
    summaryJsonPath: join(workspacePath, "summary.json"),
    summaryMdPath: join(workspacePath, "summary.md"),
    workspacePath,
  };
}

function fixtureValidation(): FixtureValidation {
  return {
    contextTreeVerifyResult: null,
    errors: [],
    ok: true,
    requiredFilesOk: true,
    sourceRepoOk: true,
    treeEmptyOk: true,
  };
}

function createManagedSourceFixture(
  tempRoot: string,
  worktreePath = join(tempRoot, "worktrees", "seed-source-repo"),
  readme = "baseline source\n",
) {
  const sourceOrigin = join(tempRoot, "source-origin");
  const sourceRepo = join(tempRoot, "source-repos", "source-repo");
  mkdirSync(sourceOrigin, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: sourceOrigin });
  execFileSync("git", ["config", "user.email", "eval@example.com"], { cwd: sourceOrigin });
  execFileSync("git", ["config", "user.name", "Eval"], { cwd: sourceOrigin });
  writeFileSync(join(sourceOrigin, ".gitignore"), "ignored/\n", "utf8");
  writeFileSync(join(sourceOrigin, "README.md"), readme, "utf8");
  execFileSync("git", ["add", ".gitignore", "README.md"], { cwd: sourceOrigin });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: sourceOrigin });
  mkdirSync(join(tempRoot, "source-repos"), { recursive: true });
  mkdirSync(join(tempRoot, "worktrees"), { recursive: true });
  mkdirSync(join(tempRoot, "outside"), { recursive: true });
  execFileSync("git", ["clone", "--bare", sourceOrigin, sourceRepo]);
  execFileSync("git", ["-C", sourceRepo, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  execFileSync("git", ["-C", sourceRepo, "fetch", "origin"]);
  execFileSync("git", ["-C", sourceRepo, "worktree", "add", "--detach", worktreePath, "main"]);
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktreePath, encoding: "utf8" }).trim();
}

describe("first-tree-seed grader", () => {
  it("passes empty-tree source-present when the model reads source through a worktree and asks for approval", () => {
    expect(
      casePassed(
        findCase("empty-tree-source-present"),
        baseMetrics({
          finalResponse:
            "Proposed domain skeleton: system, product, team-practice, members, raw-context. Reply to approve.",
        }),
      ),
    ).toBe(true);
  });

  it("fails empty-tree source-present when leaf content appears before confirmation", () => {
    expect(
      casePassed(
        findCase("empty-tree-source-present"),
        baseMetrics({
          forbiddenActionHits: ["content_before_confirmation"],
          leafContentObserved: true,
        }),
      ),
    ).toBe(false);
  });

  it("recognizes the approved structure-and-leaves single-PR build without requiring the GitHub App", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-single-pr-positive-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              item: {
                text: "Approval is confirmed. I will now build the structure and initial leaves on chore/seed-tree and open one reviewable seed PR. No GitHub App is required.",
                type: "agent_message",
              },
              type: "item.completed",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.singlePrBuildObserved).toBe(true);
      expect(metrics.singlePrBuildRefusalObserved).toBe(false);
      expect(metrics.legacyHandoffObserved).toBe(false);
      expect(metrics.githubAppRequirementObserved).toBe(false);
      expect(metrics.forbiddenActionHits).toEqual([]);
      expect(
        casePassed(
          findCase("same-chat-approved-skeleton-builds-single-pr"),
          baseMetrics({
            finalResponse: metrics.finalResponse,
            singlePrBuildObserved: true,
            singlePrBuildRefusalObserved: false,
            skeletonObserved: false,
          }),
        ),
      ).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("rejects mixed wording that reintroduces the retired merge-and-ping handoff", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-single-pr-legacy-handoff-"));
    try {
      const evalCase = findCase("same-chat-approved-skeleton-builds-single-pr");
      const metrics = deriveMetrics(
        [
          {
            event: {
              item: {
                text: "I will build the structure and initial leaves in one reviewable PR. First I will open a structure PR; merge it and ping me, then I will continue with the content.",
                type: "agent_message",
              },
              type: "item.completed",
            },
            type: "codex_event",
          },
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.singlePrBuildObserved).toBe(true);
      expect(metrics.legacyHandoffObserved).toBe(true);
      expect(metrics.forbiddenActionHits).toContain("legacy_two_pr_handoff");
      expect(
        casePassed(
          evalCase,
          baseMetrics({
            finalResponse: metrics.finalResponse,
            forbiddenActionHits: metrics.forbiddenActionHits,
            legacyHandoffObserved: metrics.legacyHandoffObserved,
            singlePrBuildObserved: metrics.singlePrBuildObserved,
            skeletonObserved: false,
          }),
        ),
      ).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not treat an explicit no-handoff statement as a legacy handoff", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-single-pr-no-legacy-handoff-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              item: {
                text: "I will build the structure and initial leaves in one reviewable seed PR, with no intermediate structure PR, merge wait, or return ping.",
                type: "agent_message",
              },
              type: "item.completed",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.singlePrBuildObserved).toBe(true);
      expect(metrics.legacyHandoffObserved).toBe(false);
      expect(metrics.forbiddenActionHits).toEqual([]);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not treat the approved checklist transition as a legacy handoff", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-single-pr-approved-transition-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              item: {
                text: "The skeleton is approved; then I will build the structure and content in the same PR.",
                type: "agent_message",
              },
              type: "item.completed",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.legacyHandoffObserved).toBe(false);
      expect(metrics.forbiddenActionHits).toEqual([]);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("allows post-merge first-tree-write guidance after the complete seed PR", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-single-pr-future-write-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              item: {
                text: "I will build structure and initial leaves in one seed PR. Merge it, then use first-tree-write for future content.",
                type: "agent_message",
              },
              type: "item.completed",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.singlePrBuildObserved).toBe(true);
      expect(metrics.legacyHandoffObserved).toBe(false);
      expect(metrics.forbiddenActionHits).toEqual([]);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("links an adjacent leaf sentence to the same complete seed PR", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-single-pr-adjacent-leaves-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              item: {
                text: "I will open one seed PR containing the structure. It also contains the initial leaves. Merge it, then use first-tree-write for future content.",
                type: "agent_message",
              },
              type: "item.completed",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.singlePrBuildObserved).toBe(true);
      expect(metrics.legacyHandoffObserved).toBe(false);
      expect(metrics.forbiddenActionHits).toEqual([]);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("rejects fill-the-leaves continuation after a structure-only PR merge", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-single-pr-fill-leaves-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              item: {
                text: "I will deliver one PR for structure and leaves. I will open the structure PR now; once merged, I will fill the leaves.",
                type: "agent_message",
              },
              type: "item.completed",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.singlePrBuildObserved).toBe(true);
      expect(metrics.legacyHandoffObserved).toBe(true);
      expect(metrics.forbiddenActionHits).toContain("legacy_two_pr_handoff");
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("rejects a comma-joined structure PR whose leaves wait for merge", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-single-pr-comma-handoff-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              item: {
                text: "I will open a PR with the structure, and once you merge it, I will add the leaves.",
                type: "agent_message",
              },
              type: "item.completed",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.legacyHandoffObserved).toBe(true);
      expect(metrics.forbiddenActionHits).toContain("legacy_two_pr_handoff");
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("recognizes the retired handoff when pull request is spelled out", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-single-pr-pull-request-handoff-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              item: {
                text: "I will open a pull request with the structure; once you merge it, I will fill the leaves.",
                type: "agent_message",
              },
              type: "item.completed",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.legacyHandoffObserved).toBe(true);
      expect(metrics.forbiddenActionHits).toContain("legacy_two_pr_handoff");
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("preserves contrastive rejection of the retired structure-PR handoff", () => {
    const responses = [
      "Rather than open a structure PR and wait for you to merge it before I add leaves, I will build structure and initial leaves in one seed PR.",
      "Instead of opening a structure PR and waiting for you to merge it before I add leaves, I will build structure and initial leaves in one seed PR.",
    ];

    for (const [index, finalResponse] of responses.entries()) {
      const tempRoot = mkdtempSync(join(tmpdir(), `seed-eval-single-pr-contrastive-negation-${index}-`));
      try {
        const metrics = deriveMetrics(
          [
            {
              event: { item: { text: finalResponse, type: "agent_message" }, type: "item.completed" },
              type: "codex_event",
            },
          ],
          findCase("same-chat-approved-skeleton-builds-single-pr"),
          fixtureValidation(),
          0,
          baseRunPaths(tempRoot),
          join(tempRoot, "context-tree"),
        );

        expect(metrics.singlePrBuildObserved, finalResponse).toBe(true);
        expect(metrics.legacyHandoffObserved, finalResponse).toBe(false);
        expect(metrics.forbiddenActionHits, finalResponse).toEqual([]);
      } finally {
        rmSync(tempRoot, { force: true, recursive: true });
      }
    }
  });

  it("treats a structure PR landing before leaves as the retired handoff", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-single-pr-lands-handoff-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              item: {
                text: "I will deliver one PR for structure and leaves. First I will open a structure PR; once it lands, I will add leaves.",
                type: "agent_message",
              },
              type: "item.completed",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.singlePrBuildObserved).toBe(true);
      expect(metrics.legacyHandoffObserved).toBe(true);
      expect(metrics.forbiddenActionHits).toContain("legacy_two_pr_handoff");
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not treat sub-agent drafts landing as the seed PR handoff", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-single-pr-drafts-land-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              item: {
                text: "I will open one seed PR with the structure. Once the sub-agent drafts land, I will add the initial leaves to that same PR before you merge it.",
                type: "agent_message",
              },
              type: "item.completed",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.singlePrBuildObserved).toBe(true);
      expect(metrics.legacyHandoffObserved).toBe(false);
      expect(metrics.forbiddenActionHits).toEqual([]);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("treats an explicit pull-request landing before leaves as the retired handoff", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-single-pr-explicit-pr-lands-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              item: {
                text: "I will open a pull request with the structure. Once that pull request lands, I will add the leaves.",
                type: "agent_message",
              },
              type: "item.completed",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.legacyHandoffObserved).toBe(true);
      expect(metrics.forbiddenActionHits).toContain("legacy_two_pr_handoff");
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not treat merging sub-agent work as the seed PR handoff", () => {
    const responses = [
      "I will open one seed PR with the structure. Once I merge the sub-agent drafts, I will add the initial leaves to that same PR before you merge it.",
      "I will open one seed PR with the structure. Once the sub-agent branches merge, I will add the initial leaves to that same PR before you merge it.",
      "I will open one seed PR with the structure. The sub-agent branches are ready; once merged, I will add the initial leaves to that same PR before you merge it.",
      "I will open one seed PR with the structure. The sub-agent drafts stay on local branches; once merged, I will add their initial leaves to that same PR before you merge it.",
      "I will open one seed PR with the structure, and the sub-agent branches are ready. Once merged, I will add the initial leaves to that same PR before you merge it.",
      "I will open one seed PR with the structure. I will review this branch first. Once merged, I will add the initial leaves to that same PR before you merge it.",
      "I will open one seed PR with the structure. That work came from the sub-agent. Once merged, I will add the initial leaves to that same PR before you merge it.",
      "I will open one seed PR with the structure, and that work came from the sub-agent. Once merged, I will add the initial leaves to that same PR before you merge it.",
      "I will open one seed PR with the structure. This branch came from the sub-agent. Once merged, I will add the initial leaves to that same PR before you merge it.",
    ];

    for (const [index, finalResponse] of responses.entries()) {
      const tempRoot = mkdtempSync(join(tmpdir(), `seed-eval-single-pr-merge-sub-agent-work-${index}-`));
      try {
        const metrics = deriveMetrics(
          [
            {
              event: { item: { text: finalResponse, type: "agent_message" }, type: "item.completed" },
              type: "codex_event",
            },
          ],
          findCase("same-chat-approved-skeleton-builds-single-pr"),
          fixtureValidation(),
          0,
          baseRunPaths(tempRoot),
          join(tempRoot, "context-tree"),
        );

        expect(metrics.singlePrBuildObserved, finalResponse).toBe(true);
        expect(metrics.legacyHandoffObserved, finalResponse).toBe(false);
        expect(metrics.forbiddenActionHits, finalResponse).toEqual([]);
      } finally {
        rmSync(tempRoot, { force: true, recursive: true });
      }
    }
  });

  it("treats merging that structure PR before leaves as the retired handoff", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-single-pr-merge-structure-pr-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              item: {
                text: "I will open a structure PR now. Once you merge that structure PR, I will add the leaves.",
                type: "agent_message",
              },
              type: "item.completed",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.legacyHandoffObserved).toBe(true);
      expect(metrics.forbiddenActionHits).toContain("legacy_two_pr_handoff");
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("treats a structure PR that has landed before leaves as the retired handoff", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-single-pr-has-landed-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              item: {
                text: "I will deliver one PR for structure and leaves. I will open a structure PR; once that PR has landed, I will add the leaves.",
                type: "agent_message",
              },
              type: "item.completed",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.singlePrBuildObserved).toBe(true);
      expect(metrics.legacyHandoffObserved).toBe(true);
      expect(metrics.forbiddenActionHits).toContain("legacy_two_pr_handoff");
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("preserves a structure PR referent through review prose before a passive merge", () => {
    const responses = [
      "I will deliver one PR for structure and leaves. I will open a structure PR for review. You can review it first. Once merged, I will add the leaves.",
      "I will deliver one PR for structure and leaves. I will open a structure PR for review. You can inspect it first. You can approve it after that. Once merged, I will add the leaves.",
      "I will deliver one PR for structure and leaves. I will open a structure PR for review. You can review this first. Once merged, I will add the leaves.",
      "I will deliver one PR for structure and leaves. I will open a structure PR for review. You can review this work first. Once merged, I will add the leaves.",
    ];

    for (const [index, finalResponse] of responses.entries()) {
      const tempRoot = mkdtempSync(join(tmpdir(), `seed-eval-single-pr-review-pronoun-${index}-`));
      try {
        const metrics = deriveMetrics(
          [
            {
              event: {
                item: {
                  text: finalResponse,
                  type: "agent_message",
                },
                type: "item.completed",
              },
              type: "codex_event",
            },
          ],
          findCase("same-chat-approved-skeleton-builds-single-pr"),
          fixtureValidation(),
          0,
          baseRunPaths(tempRoot),
          join(tempRoot, "context-tree"),
        );

        expect(metrics.singlePrBuildObserved, finalResponse).toBe(true);
        expect(metrics.legacyHandoffObserved, finalResponse).toBe(true);
        expect(metrics.forbiddenActionHits, finalResponse).toContain("legacy_two_pr_handoff");
      } finally {
        rmSync(tempRoot, { force: true, recursive: true });
      }
    }
  });

  it("rejects a structure-first PR whose merge gates leaf drafting", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-single-pr-structure-first-"));
    try {
      const evalCase = findCase("same-chat-approved-skeleton-builds-single-pr");
      const metrics = deriveMetrics(
        [
          {
            event: {
              item: {
                text: "I will open a PR with the structure; once you merge it, I will add the leaves.",
                type: "agent_message",
              },
              type: "item.completed",
            },
            type: "codex_event",
          },
        ],
        evalCase,
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.legacyHandoffObserved).toBe(true);
      expect(metrics.forbiddenActionHits).toContain("legacy_two_pr_handoff");
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("accepts natural no-stop wording as a negated refusal", () => {
    const responses = [
      "I will build the structure and initial leaves in one PR without stopping for another approval.",
      "I will build the structure and initial leaves in one PR without an intermediate stop.",
      "I will build the structure and initial leaves in one PR with no intermediate stopping point.",
    ];

    for (const [index, finalResponse] of responses.entries()) {
      const tempRoot = mkdtempSync(join(tmpdir(), `seed-eval-single-pr-no-stop-${index}-`));
      try {
        const metrics = deriveMetrics(
          [
            {
              event: { item: { text: finalResponse, type: "agent_message" }, type: "item.completed" },
              type: "codex_event",
            },
          ],
          findCase("same-chat-approved-skeleton-builds-single-pr"),
          fixtureValidation(),
          0,
          baseRunPaths(tempRoot),
          join(tempRoot, "context-tree"),
        );

        expect(metrics.singlePrBuildRefusalObserved, finalResponse).toBe(false);
        expect(metrics.singlePrBuildObserved, finalResponse).toBe(true);
      } finally {
        rmSync(tempRoot, { force: true, recursive: true });
      }
    }
  });

  it("requires the approved single-PR build case to read the visible prior-turn transcript", () => {
    const evalCase = findCase("same-chat-approved-skeleton-builds-single-pr");
    const metrics = baseMetrics({
      chatHistoryReadObserved: false,
      finalResponse:
        "Approval is confirmed. I will build the structure and initial leaves and open one reviewable seed PR.",
      singlePrBuildObserved: true,
      skeletonObserved: false,
    });

    expect(casePassed(evalCase, metrics)).toBe(false);
    expect(buildGrading(evalCase, metrics, false).scores.process_pass).toBe(false);
  });

  it("does not treat an eval-only stop before side effects as refusing the approved build", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-single-pr-eval-stop-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              item: {
                text: "Approval is confirmed. I will build the structure and initial leaves on chore/seed-tree and open one seed PR. Per the eval restriction, I stopped before side effects.",
                type: "agent_message",
              },
              type: "item.completed",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.singlePrBuildObserved).toBe(true);
      expect(metrics.singlePrBuildRefusalObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("records same-chat history only after a successful content read with transcript evidence", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-single-pr-history-read-"));
    try {
      mkdirSync(join(tempRoot, ".first-tree-eval"), { recursive: true });
      writeFileSync(
        join(tempRoot, ".first-tree-eval", "chat-history.md"),
        approvedSkeletonChatHistoryMarkdown(),
        "utf8",
      );
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: approvedSkeletonChatHistoryMarkdown(),
              command: "cat .first-tree-eval/chat-history.md",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.chatHistoryReadObserved).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not credit a transcript replaced with self-authored evidence", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-replaced-history-"));
    try {
      mkdirSync(join(tempRoot, ".first-tree-eval"), { recursive: true });
      writeFileSync(
        join(tempRoot, ".first-tree-eval", "chat-history.md"),
        "Skeleton proposal\nApproved\none reviewable PR\n",
        "utf8",
      );
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "Skeleton proposal\nApproved\none reviewable PR",
              command: "cat .first-tree-eval/chat-history.md",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.chatHistoryReadObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not credit transient transcript evidence after the original is restored", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-restored-history-"));
    try {
      mkdirSync(join(tempRoot, ".first-tree-eval"), { recursive: true });
      writeFileSync(
        join(tempRoot, ".first-tree-eval", "chat-history.md"),
        approvedSkeletonChatHistoryMarkdown(),
        "utf8",
      );
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "Skeleton proposal\nApproved\none reviewable PR\n",
              command: "cat .first-tree-eval/chat-history.md",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.chatHistoryReadObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not credit transcript evidence through a symlinked fixture directory", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-symlinked-history-parent-"));
    const externalEvalDir = join(tempRoot, "external-eval");
    try {
      mkdirSync(externalEvalDir, { recursive: true });
      writeFileSync(join(externalEvalDir, "chat-history.md"), approvedSkeletonChatHistoryMarkdown(), "utf8");
      symlinkSync(externalEvalDir, join(tempRoot, ".first-tree-eval"));
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: approvedSkeletonChatHistoryMarkdown(),
              command: "cat .first-tree-eval/chat-history.md",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.chatHistoryReadObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("requires proposal and approval evidence from the transcript read", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-single-pr-incomplete-history-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "Skeleton proposal: product and system.\nApproved.",
              command: "cat .first-tree-eval/chat-history.md",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.chatHistoryReadObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not borrow same-chat evidence from an independent Context Tree read", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-single-pr-mixed-history-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output:
                "Skeleton proposal: product and system.\nApproved.\nBuild structure and leaves in one reviewable PR.",
              command:
                "test -f .first-tree-eval/chat-history.md && cat .first-tree-eval/chat-history.md; sed -n 1,120p context-tree/NODE.md",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.chatHistoryReadObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not credit a skipped transcript read followed by literal evidence", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-single-pr-skipped-history-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "Skeleton proposal\nApproved\nBuild structure and leaves in one reviewable PR.",
              command:
                "false && cat .first-tree-eval/chat-history.md; printf 'Skeleton proposal\\nApproved\\nBuild structure and leaves in one reviewable PR.\\n'",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.chatHistoryReadObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not credit a skipped transcript read followed by variable-expanded evidence", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-single-pr-variable-history-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "Skeleton proposal\nApproved\none reviewable PR",
              command:
                "H='Skeleton proposal\\nApproved\\none reviewable PR'; false && cat .first-tree-eval/chat-history.md; printf '%b\\n' \"$H\"",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.chatHistoryReadObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not credit transcript evidence from another file operand in the same reader", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-single-pr-multi-file-history-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "Skeleton proposal\nApproved\none reviewable PR",
              command: "cat .first-tree-eval/chat-history.md context-tree/NODE.md",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.chatHistoryReadObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not credit a transcript path outside the current eval workspace", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-single-pr-wrong-root-history-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "Skeleton proposal\nApproved\none reviewable PR",
              command: "cat /tmp/.first-tree-eval/chat-history.md",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.chatHistoryReadObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not credit transcript operands with shell expansion or an untrusted reader", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-single-pr-expanded-history-"));
    const commands = [
      'cat ".first-tree-eval/$(printf chat-history.md)"',
      'cat ".first-tree-eval/$H"',
      "cat .first-tree-eval/{chat-history.md,other.md}",
      "/tmp/cat .first-tree-eval/chat-history.md",
    ];
    try {
      for (const command of commands) {
        const metrics = deriveMetrics(
          [
            {
              event: {
                aggregated_output: "Skeleton proposal\nApproved\none reviewable PR",
                command,
                exit_code: 0,
                status: "completed",
                type: "command_execution",
              },
              type: "codex_event",
            },
          ],
          findCase("same-chat-approved-skeleton-builds-single-pr"),
          fixtureValidation(),
          0,
          baseRunPaths(tempRoot),
          join(tempRoot, "context-tree"),
        );

        expect(metrics.chatHistoryReadObserved, command).toBe(false);
      }
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not credit transcript hints synthesized by a rewriting pipeline filter", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-single-pr-rewrite-history-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "Skeleton proposal Approved one reviewable PR",
              command:
                "cat .first-tree-eval/chat-history.md | rg --replace='Skeleton proposal Approved one reviewable PR' '.+'",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.chatHistoryReadObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not credit transcript hints synthesized by an awk BEGIN block", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-single-pr-awk-history-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "Skeleton proposal\nApproved\none reviewable PR",
              command:
                'awk \'BEGIN { print "Skeleton proposal"; print "Approved"; print "one reviewable PR"; exit }\' .first-tree-eval/chat-history.md',
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.chatHistoryReadObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not credit a failed transcript content read", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-single-pr-failed-history-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output:
                "cat: .first-tree-eval/chat-history.md: No such file\nSkeleton proposal\nApproved\none reviewable PR",
              command: "cat .first-tree-eval/chat-history.md",
              exit_code: 1,
              status: "failed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.chatHistoryReadObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not credit a transcript path mention or existence check as reading prior turns", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-single-pr-history-spoof-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: ".first-tree-eval/chat-history.md exists",
              command: "test -f .first-tree-eval/chat-history.md && echo .first-tree-eval/chat-history.md exists",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.chatHistoryReadObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not count Context Tree output as source evidence without a source path read", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-tree-is-not-source-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "# Apollo Console\nApproved domain skeleton.",
              command: "sed -n '1,120p' context-tree/NODE.md",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceEvidenceReadObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not count first-tree-write mentions in first-tree-seed skill output as write-skill reads", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-write-skill-mention-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "Later incremental updates go through first-tree-write.",
              command: "sed -n '1,160p' .agents/skills/first-tree-seed/SKILL.md",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("empty-tree-source-present"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.seedSkillFileReadObserved).toBe(true);
      expect(metrics.writeSkillFileReadObserved).toBe(false);
      expect(casePassed(findCase("empty-tree-source-present"), baseMetrics())).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not count workspace manifest mentions in command output as manifest reads", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-manifest-mention-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "The briefing says to read .first-tree/workspace.json before seeding.",
              command: "sed -n '1,200p' AGENTS.md",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("empty-tree-source-present"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.workspaceManifestReadObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("passes non-empty tree refusal without source worktree exploration", () => {
    expect(
      casePassed(
        findCase("non-empty-tree-refuses"),
        baseMetrics({
          finalResponse: "The tree is already non-empty; use first-tree-write or a focused maintenance task.",
          skeletonObserved: false,
          sourceEvidenceReadObserved: false,
          sourceWorktreeAccessObserved: false,
          sourceWorktreeCreated: false,
        }),
      ),
    ).toBe(true);
  });

  it("fails non-empty tree refusal when a source worktree was touched then removed before grading", () => {
    // Event-level worktree access (add/read/remove) is Phase-1 exploration and
    // must fail refusal even if the final filesystem is clean.
    expect(
      casePassed(
        findCase("non-empty-tree-refuses"),
        baseMetrics({
          skeletonObserved: false,
          sourceEvidenceReadObserved: false,
          sourceWorktreeAccessObserved: true,
          sourceWorktreeCreated: false,
        }),
      ),
    ).toBe(false);
  });

  it("fails non-empty tree refusal when seed continues into source exploration", () => {
    expect(
      casePassed(
        findCase("non-empty-tree-refuses"),
        baseMetrics({
          forbiddenActionHits: ["continue_seed"],
          skeletonObserved: false,
          sourceWorktreeCreated: true,
        }),
      ),
    ).toBe(false);
  });

  it("fails non-empty tree refusal when source evidence is read without a worktree", () => {
    expect(
      casePassed(
        findCase("non-empty-tree-refuses"),
        baseMetrics({
          skeletonObserved: false,
          sourceEvidenceReadObserved: true,
          sourceWorktreeCreated: false,
        }),
      ),
    ).toBe(false);
  });

  it("fails non-empty tree refusal when the bare source path is read directly", () => {
    expect(
      casePassed(
        findCase("non-empty-tree-refuses"),
        baseMetrics({
          directBareSourceContentReadObserved: true,
          skeletonObserved: false,
          sourceEvidenceReadObserved: false,
          sourceWorktreeCreated: false,
        }),
      ),
    ).toBe(false);
  });

  it("passes missing-source refusal without invented skeleton", () => {
    expect(
      casePassed(
        findCase("source-missing-refuses"),
        baseMetrics({
          finalResponse: "The source clone is missing at source-repos/source-repo; provisioning is incomplete.",
          skeletonObserved: false,
          sourceEvidenceReadObserved: false,
          sourceWorktreeAccessObserved: false,
          sourceWorktreeCreated: false,
        }),
      ),
    ).toBe(true);
  });

  it("fails missing-source refusal when a source worktree was touched then removed before grading", () => {
    expect(
      casePassed(
        findCase("source-missing-refuses"),
        baseMetrics({
          skeletonObserved: false,
          sourceEvidenceReadObserved: false,
          sourceWorktreeAccessObserved: true,
          sourceWorktreeCreated: false,
        }),
      ),
    ).toBe(false);
  });

  it("passes bare-source protocol when source is read from materialized worktree", () => {
    expect(
      casePassed(
        findCase("bare-source-worktree-protocol"),
        baseMetrics({
          finalResponse: "I created a seed-source-repo worktree and propose a domain skeleton for approval.",
        }),
      ),
    ).toBe(true);
  });

  it("does not pass worktree provenance after the read worktree is cleaned up", () => {
    const evalCase = findCase("bare-source-worktree-protocol");
    const metrics = baseMetrics({
      finalResponse: "I read the source worktree, cleaned it up, and propose a domain skeleton for approval.",
      sourceWorktreeAccessObserved: true,
      sourceWorktreeCreated: false,
      sourceWorktreeMaterializedObserved: false,
    });

    expect(casePassed(evalCase, metrics)).toBe(false);
    expect(buildGrading(evalCase, metrics, false).scores.process_pass).toBe(false);
  });

  it("does not pass cleanup when worktree materialization and source reads only failed", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-failed-worktree-attempt-"));
    try {
      const derived = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "fatal: invalid reference: origin/main",
              command: "git -C source-repos/source-repo worktree add worktrees/seed-source-repo origin/main",
              exit_code: 128,
              status: "failed",
              type: "command_execution",
            },
            type: "codex_event",
          },
          {
            event: {
              aggregated_output: "cat: worktrees/seed-source-repo/README.md: No such file or directory",
              command: "cat worktrees/seed-source-repo/README.md",
              exit_code: 1,
              status: "failed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("bare-source-worktree-protocol"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(derived.sourceWorktreeAccessObserved).toBe(true);
      expect(derived.sourceWorktreeMaterializedObserved).toBe(false);
      expect(derived.sourceEvidenceReadObserved).toBe(false);
      expect(
        casePassed(
          findCase("bare-source-worktree-protocol"),
          baseMetrics({
            sourceEvidenceReadObserved: derived.sourceEvidenceReadObserved,
            sourceWorktreeAccessObserved: derived.sourceWorktreeAccessObserved,
            sourceWorktreeCreated: false,
            sourceWorktreeMaterializedObserved: derived.sourceWorktreeMaterializedObserved,
          }),
        ),
      ).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not credit a worktree command without final managed state", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-successful-worktree-add-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "Preparing worktree (detached HEAD 1234567)",
              command: `git -C source-repos/source-repo worktree add ${join(tempRoot, "worktrees", "seed-source-repo")} origin/main`,
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("bare-source-worktree-protocol"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceWorktreeMaterializedObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not treat argv consumed by a Git alias as a worktree add", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-git-alias-worktree-add-"));
    const managedPath = join(tempRoot, "worktrees", "seed-source-repo");
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "",
              command: `git -C source-repos/source-repo -c alias.foo='!true' foo worktree add ${managedPath} origin/main`,
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("bare-source-worktree-protocol"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceWorktreeMaterializedObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not treat a shadowed Git shell function as a worktree add", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-git-function-worktree-add-"));
    const managedPath = join(tempRoot, "worktrees", "seed-source-repo");
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "",
              command: `git() { return 0; }\ngit -C source-repos/source-repo worktree add ${managedPath} origin/main`,
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("bare-source-worktree-protocol"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceWorktreeMaterializedObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not infer worktree materialization from aggregate Git-looking output", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-worktree-add-before-log-"));
    const managedPath = join(tempRoot, "worktrees", "seed-source-repo");
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "Preparing worktree (detached HEAD 1234567)\nHEAD is now at 1234567 fixture\nready",
              command: `git -C source-repos/source-repo worktree add ${managedPath} origin/main; echo ready`,
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("bare-source-worktree-protocol"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceWorktreeMaterializedObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("requires the managed worktree add to be the standalone successful command", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-worktree-add-chain-"));
    const managedPath = join(tempRoot, "worktrees", "seed-source-repo");
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "Preparing worktree (detached HEAD 1234567)\nHEAD is now at 1234567 fixture",
              command: `git -C source-repos/source-repo worktree add ${managedPath} origin/main && true`,
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("bare-source-worktree-protocol"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceWorktreeMaterializedObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not credit encoded Git-looking output after a skipped worktree add", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-encoded-worktree-output-"));
    const managedPath = join(tempRoot, "worktrees", "seed-source-repo");
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "Preparing worktree (detached HEAD 1234567)\nHEAD is now at 1234567 fixture",
              command:
                `false && git -C source-repos/source-repo worktree add ${managedPath} origin/main; ` +
                "node -e \"process.stdout.write(Buffer.from(process.argv[1], 'base64').toString())\" UHJlcGFyaW5nIHdvcmt0cmVlIChkZXRhY2hlZCBIRUFEIDEyMzQ1NjcpCkhFQUQgaXMgbm93IGF0IDEyMzQ1NjcgZml4dHVyZQ==",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("bare-source-worktree-protocol"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceWorktreeMaterializedObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("attributes separate wrapped worktree materialization and source pipeline evidence", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-wrapped-source-loop-"));
    const managedPath = join(tempRoot, "worktrees", "seed-source-repo");
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "Preparing worktree (detached HEAD 1234567)\nHEAD is now at 1234567 fixture",
              command: `/bin/zsh -lc 'git -C source-repos/source-repo worktree add ${managedPath} origin/main'`,
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
          {
            event: {
              aggregated_output: "# Apollo Console\nContext Tree commands\nruntime coordination",
              command: `/bin/zsh -lc 'cat ${managedPath}/README.md | head -50'`,
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceWorktreeMaterializedObserved).toBe(false);
      expect(metrics.sourceEvidenceReadObserved).toBe(true);
      expect(metrics.directBareSourceContentReadObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not let a skipped source loop iteration borrow Context Tree evidence", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-skipped-source-loop-"));
    const managedPath = join(tempRoot, "worktrees", "seed-source-repo");
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: `FILE ${managedPath}/README.md\nFILE context-tree/NODE.md\n# Apollo Console\nruntime coordination`,
              command:
                `for f in ${managedPath}/README.md context-tree/NODE.md; do ` +
                'echo "FILE $f"; test "$f" = context-tree/NODE.md && sed -n 1,80p "$f"; done',
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceEvidenceReadObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not let a source output block bypass an independent Context Tree reader", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-source-block-independent-reader-"));
    const managedPath = join(tempRoot, "worktrees", "seed-source-repo");
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: `FILE ${managedPath}/README.md\n# Apollo Console\nruntime coordination`,
              command:
                `for f in ${managedPath}/README.md; do echo "FILE $f"; false && sed -n 1,80p "$f"; ` +
                "sed -n 1,80p context-tree/NODE.md; done",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceEvidenceReadObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not let unrelated Git output credit a skipped managed worktree add", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-skipped-add-git-output-"));
    const managedPath = join(tempRoot, "worktrees", "seed-source-repo");
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "HEAD is now at 1234567 fixture",
              command:
                `false && git -C source-repos/source-repo worktree add ${managedPath} origin/main; ` +
                "git -C context-tree reset --hard HEAD",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("bare-source-worktree-protocol"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceWorktreeMaterializedObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not credit a worktree add from the Context Tree repository", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-wrong-source-worktree-add-"));
    const managedPath = join(tempRoot, "worktrees", "seed-source-repo");
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "Preparing worktree (detached HEAD 1234567)\nHEAD is now at 1234567 fixture",
              command: `git -C context-tree worktree add ${managedPath} origin/main`,
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("bare-source-worktree-protocol"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceWorktreeMaterializedObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not credit a source worktree add whose target only prefixes the managed path", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-prefixed-worktree-target-"));
    const backupPath = join(tempRoot, "worktrees", "seed-source-repo-backup");
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "Preparing worktree (detached HEAD 1234567)\nHEAD is now at 1234567 fixture",
              command: `git -C source-repos/source-repo worktree add ${backupPath} origin/main`,
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("bare-source-worktree-protocol"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceWorktreeMaterializedObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("credits final managed state linked to the declared bare source clone", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-managed-source-worktree-"));
    const sourceOrigin = join(tempRoot, "source-origin");
    const sourceRepo = join(tempRoot, "source-repos", "source-repo");
    const managedPath = join(tempRoot, "worktrees", "seed-source-repo");
    try {
      mkdirSync(sourceOrigin, { recursive: true });
      execFileSync("git", ["init", "-b", "main"], { cwd: sourceOrigin });
      execFileSync("git", ["config", "user.email", "eval@example.com"], { cwd: sourceOrigin });
      execFileSync("git", ["config", "user.name", "Eval"], { cwd: sourceOrigin });
      writeFileSync(join(sourceOrigin, "README.md"), "# Apollo Console\nruntime coordination\n", "utf8");
      execFileSync("git", ["add", "README.md"], { cwd: sourceOrigin });
      execFileSync("git", ["commit", "-m", "fixture"], { cwd: sourceOrigin });
      mkdirSync(join(tempRoot, "source-repos"), { recursive: true });
      mkdirSync(join(tempRoot, "worktrees"), { recursive: true });
      execFileSync("git", ["clone", "--bare", sourceOrigin, sourceRepo]);
      execFileSync("git", ["-C", sourceRepo, "worktree", "add", "--detach", managedPath, "main"]);
      const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: managedPath,
        encoding: "utf8",
      }).trim();

      const metrics = deriveMetrics(
        [{ type: "fixture_setup_finished", sourceRepoHead: sourceHead }],
        findCase("bare-source-worktree-protocol"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceWorktreeCreated).toBe(true);
      expect(metrics.sourceWorktreeMaterializedObserved).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("rejects ignored self-authored source evidence in the managed worktree", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-ignored-source-evidence-"));
    const managedPath = join(tempRoot, "worktrees", "seed-source-repo");
    try {
      const sourceHead = createManagedSourceFixture(tempRoot);
      mkdirSync(join(managedPath, "ignored"), { recursive: true });
      writeFileSync(join(managedPath, "ignored", "evidence.txt"), "Apollo Console\nruntime coordination\n", "utf8");
      const metrics = deriveMetrics(
        [
          { type: "fixture_setup_finished", sourceRepoHead: sourceHead },
          {
            event: {
              aggregated_output: "Apollo Console\nruntime coordination",
              command: "cat worktrees/seed-source-repo/ignored/evidence.txt",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceEvidenceReadObserved).toBe(false);
      expect(metrics.sourceWorktreeMaterializedObserved).toBe(false);
      expect(metrics.sourceRepoChanged).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("rejects assume-unchanged source content that differs from HEAD", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-assume-unchanged-source-"));
    const managedPath = join(tempRoot, "worktrees", "seed-source-repo");
    try {
      const sourceHead = createManagedSourceFixture(tempRoot);
      execFileSync("git", ["update-index", "--assume-unchanged", "README.md"], { cwd: managedPath });
      writeFileSync(join(managedPath, "README.md"), "Apollo Console\nruntime coordination\n", "utf8");
      const metrics = deriveMetrics(
        [
          { type: "fixture_setup_finished", sourceRepoHead: sourceHead },
          {
            event: {
              aggregated_output: "Apollo Console\nruntime coordination",
              command: "cat worktrees/seed-source-repo/README.md",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceEvidenceReadObserved).toBe(false);
      expect(metrics.sourceWorktreeMaterializedObserved).toBe(false);
      expect(metrics.sourceRepoChanged).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("rejects a symlink at the exact managed worktree path", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-symlink-managed-worktree-"));
    const managedPath = join(tempRoot, "worktrees", "seed-source-repo");
    const outsidePath = join(tempRoot, "outside", "source-worktree");
    try {
      const sourceHead = createManagedSourceFixture(tempRoot, outsidePath);
      symlinkSync(outsidePath, managedPath);
      const metrics = deriveMetrics(
        [
          { type: "fixture_setup_finished", sourceRepoHead: sourceHead },
          {
            event: {
              aggregated_output: "Apollo Console\nruntime coordination",
              command: "cat worktrees/seed-source-repo/README.md",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceEvidenceReadObserved).toBe(false);
      expect(metrics.sourceWorktreeMaterializedObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("credits source evidence only when output matches the baseline tracked file", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-baseline-source-evidence-"));
    const sourceOutput = "# Apollo Console\nruntime coordination\n";
    try {
      const sourceHead = createManagedSourceFixture(
        tempRoot,
        join(tempRoot, "worktrees", "seed-source-repo"),
        sourceOutput,
      );
      const metrics = deriveMetrics(
        [
          { type: "fixture_setup_finished", sourceRepoHead: sourceHead },
          {
            event: {
              aggregated_output: sourceOutput,
              command: "cat worktrees/seed-source-repo/README.md",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceEvidenceReadObserved).toBe(true);
      expect(metrics.sourceWorktreeMaterializedObserved).toBe(true);
      expect(metrics.sourceRepoChanged).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not credit transient source evidence after the tracked file is restored", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-restored-source-evidence-"));
    try {
      const sourceHead = createManagedSourceFixture(tempRoot);
      const metrics = deriveMetrics(
        [
          { type: "fixture_setup_finished", sourceRepoHead: sourceHead },
          {
            event: {
              aggregated_output: "Apollo Console\nruntime coordination\n",
              command: "cat worktrees/seed-source-repo/README.md",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceEvidenceReadObserved).toBe(false);
      expect(metrics.sourceWorktreeMaterializedObserved).toBe(true);
      expect(metrics.sourceRepoChanged).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not treat an ordinary clone at the managed path as the declared source worktree", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-ordinary-clone-worktree-"));
    const sourceOrigin = join(tempRoot, "source-origin");
    const sourceRepo = join(tempRoot, "source-repos", "source-repo");
    const managedPath = join(tempRoot, "worktrees", "seed-source-repo");
    try {
      mkdirSync(sourceOrigin, { recursive: true });
      execFileSync("git", ["init", "-b", "main"], { cwd: sourceOrigin });
      execFileSync("git", ["config", "user.email", "eval@example.com"], { cwd: sourceOrigin });
      execFileSync("git", ["config", "user.name", "Eval"], { cwd: sourceOrigin });
      writeFileSync(join(sourceOrigin, "README.md"), "# Apollo Console\nruntime coordination\n", "utf8");
      execFileSync("git", ["add", "README.md"], { cwd: sourceOrigin });
      execFileSync("git", ["commit", "-m", "fixture"], { cwd: sourceOrigin });
      mkdirSync(join(tempRoot, "source-repos"), { recursive: true });
      mkdirSync(join(tempRoot, "worktrees"), { recursive: true });
      execFileSync("git", ["clone", "--bare", sourceOrigin, sourceRepo]);
      execFileSync("git", ["clone", sourceRepo, managedPath]);
      const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: managedPath, encoding: "utf8" }).trim();

      const metrics = deriveMetrics(
        [
          { type: "fixture_setup_finished", sourceRepoHead: sourceHead },
          {
            event: {
              aggregated_output: "",
              command: `git -C source-repos/source-repo -c alias.foo='!true' foo worktree add ${managedPath} origin/main`,
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
          {
            event: {
              aggregated_output: "Apollo Console\nruntime coordination\n",
              command: `cat ${managedPath}/README.md`,
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("bare-source-worktree-protocol"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceWorktreeCreated).toBe(true);
      expect(metrics.sourceWorktreeMaterializedObserved).toBe(false);
      expect(metrics.sourceEvidenceReadObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not credit literal Git success output as worktree materialization", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-spoofed-worktree-output-"));
    const managedPath = join(tempRoot, "worktrees", "seed-source-repo");
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "Preparing worktree (detached HEAD 1234567)\nHEAD is now at 1234567 fixture",
              command: `false && git -C source-repos/source-repo worktree add ${managedPath} origin/main; printf 'Preparing worktree (detached HEAD 1234567)\\nHEAD is now at 1234567 fixture\\n'`,
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("bare-source-worktree-protocol"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceWorktreeMaterializedObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not credit a successful worktree created inside the bare clone", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-wrong-worktree-location-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "Preparing worktree (detached HEAD 1234567)",
              command:
                "git -C source-repos/source-repo worktree add source-repos/source-repo/worktrees/seed-source-repo origin/main",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("bare-source-worktree-protocol"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceWorktreeAccessObserved).toBe(true);
      expect(metrics.sourceWorktreeMaterializedObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not treat a wrapped doc search for worktree instructions as materialization", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-wrapped-worktree-doc-search-"));
    const managedPath = join(tempRoot, "worktrees", "seed-source-repo");
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: `git worktree add ${managedPath} origin/main`,
              command: `/bin/zsh -lc "rg \\"worktree add ${managedPath}\\" AGENTS.md"`,
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("bare-source-worktree-protocol"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceWorktreeAccessObserved).toBe(false);
      expect(metrics.sourceWorktreeMaterializedObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not attribute a failed wrapped source read to later Context Tree output", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-compound-source-failure-"));
    const managedPath = join(tempRoot, "worktrees", "seed-source-repo");
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: `find: ${managedPath}: No such file or directory\n# Apollo Console\nruntime coordination`,
              command: `/bin/zsh -lc "find ${managedPath} -type f; sed -n '1,120p' context-tree/NODE.md"`,
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceEvidenceReadObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not credit wrapped worktree and source commands skipped by shell control flow", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-skipped-shell-segments-"));
    const managedPath = join(tempRoot, "worktrees", "seed-source-repo");
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "",
              command: `/bin/zsh -lc "false && git -C source-repos/source-repo worktree add ${managedPath} origin/main; true"`,
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
          {
            event: {
              aggregated_output: "# Apollo Console\nruntime coordination",
              command: `/bin/zsh -lc "test -f ${managedPath}/README.md && cat ${managedPath}/README.md; sed -n '1,120p' context-tree/NODE.md"`,
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(existsSync(managedPath)).toBe(false);
      expect(metrics.sourceWorktreeMaterializedObserved).toBe(false);
      expect(metrics.sourceEvidenceReadObserved).toBe(false);
      expect(
        casePassed(
          findCase("same-chat-approved-skeleton-builds-single-pr"),
          baseMetrics({
            sourceEvidenceReadObserved: metrics.sourceEvidenceReadObserved,
            sourceWorktreeMaterializedObserved: metrics.sourceWorktreeMaterializedObserved,
          }),
        ),
      ).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("passes real first-tree periodic case when source evidence is read through a worktree", () => {
    expect(
      casePassed(
        findCase("first-tree-seed-real-first-tree-source-periodic"),
        baseMetrics({
          finalResponse:
            "Proposed domain skeleton: system, context-management, cloud, team-practice, members. Reply to approve.",
        }),
      ),
    ).toBe(true);
  });

  it("detects real first-tree source evidence read from the materialized worktree", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-real-source-read-"));
    try {
      const realReadme = readFileSync(join(process.cwd(), "..", "..", "README.md"), "utf8");
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: realReadme,
              command: "cat worktrees/seed-source-repo/README.md",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("first-tree-seed-real-first-tree-source-periodic"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceEvidenceReadObserved).toBe(true);
      expect(metrics.directBareSourceContentReadObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("detects real first-tree package and README evidence without synthetic fixture phrases", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-real-source-meta-read-"));
    try {
      const repoRoot = join(process.cwd(), "..", "..");
      const actualOutput = [
        readFileSync(join(repoRoot, "package.json"), "utf8"),
        readFileSync(join(repoRoot, "README.md"), "utf8"),
      ].join("\n");
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: actualOutput,
              command: "cat worktrees/seed-source-repo/package.json && cat worktrees/seed-source-repo/README.md",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("first-tree-seed-real-first-tree-source-periodic"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceEvidenceReadObserved).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("attributes a pure pipeline filter to its source read", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-piped-source-read-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "# Apollo Console\nruntime coordination",
              command: "cat worktrees/seed-source-repo/README.md | head -50",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceEvidenceReadObserved).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not attribute a pipeline stage with its own Context Tree file operand to source", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-mixed-pipeline-read-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "# Apollo Console\nruntime coordination",
              command: "cat worktrees/seed-source-repo/README.md | head -50 context-tree/NODE.md",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceEvidenceReadObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("keeps source evidence fail-closed when headings are mixed into the reader command", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-source-read-headings-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "README\n# Apollo Console\narchitecture\nruntime coordination",
              command:
                "echo README; cat worktrees/seed-source-repo/README.md; echo architecture; cat worktrees/seed-source-repo/docs/architecture.md",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceEvidenceReadObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not credit a skipped source read followed by variable-expanded evidence", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-variable-source-evidence-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "Apollo Console\nruntime coordination",
              command:
                "H='Apollo Console\\nruntime coordination'; false && cat worktrees/seed-source-repo/README.md; printf '%b\\n' \"$H\"",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceEvidenceReadObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not credit source evidence from another file operand in the same reader", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-multi-file-source-evidence-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "Apollo Console\nruntime coordination",
              command: "cat worktrees/seed-source-repo/README.md context-tree/NODE.md",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceEvidenceReadObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not credit source-like operands outside the current managed source root", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-wrong-root-source-evidence-"));
    const commands = [
      "cat /tmp/worktrees/seed-source-repo/README.md",
      "cat worktrees/seed-source-repo/../../context-tree/NODE.md",
      "cat worktrees/seed-source-repo/../seed-source-repo-evil/README.md",
    ];
    try {
      for (const command of commands) {
        const metrics = deriveMetrics(
          [
            {
              event: {
                aggregated_output: "Apollo Console\nruntime coordination",
                command,
                exit_code: 0,
                status: "completed",
                type: "command_execution",
              },
              type: "codex_event",
            },
          ],
          findCase("same-chat-approved-skeleton-builds-single-pr"),
          fixtureValidation(),
          0,
          baseRunPaths(tempRoot),
          join(tempRoot, "context-tree"),
        );

        expect(metrics.sourceEvidenceReadObserved, command).toBe(false);
      }
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not credit source operands whose shell expansion can escape the managed root", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-expanded-source-evidence-"));
    const commands = [
      'cat "worktrees/seed-source-repo/$(printf ../../context-tree/NODE.md)"',
      "cat worktrees/seed-source-repo/{../../context-tree/NODE.md,README.md}",
      'cat "worktrees/seed-source-repo/$P"',
      "cat worktrees/seed-source-repo/*.md",
      "/tmp/cat worktrees/seed-source-repo/README.md",
    ];
    try {
      for (const command of commands) {
        const metrics = deriveMetrics(
          [
            {
              event: {
                aggregated_output: "Apollo Console\nruntime coordination",
                command,
                exit_code: 0,
                status: "completed",
                type: "command_execution",
              },
              type: "codex_event",
            },
          ],
          findCase("same-chat-approved-skeleton-builds-single-pr"),
          fixtureValidation(),
          0,
          baseRunPaths(tempRoot),
          join(tempRoot, "context-tree"),
        );

        expect(metrics.sourceEvidenceReadObserved, command).toBe(false);
      }
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not credit source or history reads with hidden stdin redirection", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-hidden-redirection-"));
    const cases = [
      {
        command: "cat worktrees/seed-source-repo/package.json -<context-tree/NODE.md",
        evalCase: findCase("same-chat-approved-skeleton-builds-single-pr"),
        output: "Apollo Console\nruntime coordination",
        readMetric: "sourceEvidenceReadObserved" as const,
      },
      {
        command: "head -n 50 worktrees/seed-source-repo/package.json -<context-tree/NODE.md",
        evalCase: findCase("same-chat-approved-skeleton-builds-single-pr"),
        output: "Apollo Console\nruntime coordination",
        readMetric: "sourceEvidenceReadObserved" as const,
      },
      {
        command: "tail -n 50 worktrees/seed-source-repo/package.json -<context-tree/NODE.md",
        evalCase: findCase("same-chat-approved-skeleton-builds-single-pr"),
        output: "Apollo Console\nruntime coordination",
        readMetric: "sourceEvidenceReadObserved" as const,
      },
      {
        command: "head -n $N worktrees/seed-source-repo/package.json",
        evalCase: findCase("same-chat-approved-skeleton-builds-single-pr"),
        output: "Apollo Console\nruntime coordination",
        readMetric: "sourceEvidenceReadObserved" as const,
      },
      {
        command: "head -n {5,context-tree/NODE.md} worktrees/seed-source-repo/package.json",
        evalCase: findCase("same-chat-approved-skeleton-builds-single-pr"),
        output: "Apollo Console\nruntime coordination",
        readMetric: "sourceEvidenceReadObserved" as const,
      },
      {
        command: "cat .first-tree-eval/chat-history.md -<context-tree/NODE.md",
        evalCase: findCase("same-chat-approved-skeleton-builds-single-pr"),
        output: "Skeleton proposal\nApproved\none reviewable PR",
        readMetric: "chatHistoryReadObserved" as const,
      },
    ];
    try {
      for (const testCase of cases) {
        const metrics = deriveMetrics(
          [
            {
              event: {
                aggregated_output: testCase.output,
                command: testCase.command,
                exit_code: 0,
                status: "completed",
                type: "command_execution",
              },
              type: "codex_event",
            },
          ],
          testCase.evalCase,
          fixtureValidation(),
          0,
          baseRunPaths(tempRoot),
          join(tempRoot, "context-tree"),
        );

        expect(metrics[testCase.readMetric], testCase.command).toBe(false);
      }
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not credit source hints synthesized by a rewriting pipeline filter", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-rewrite-source-evidence-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "Apollo Console runtime coordination",
              command:
                "cat worktrees/seed-source-repo/package.json | rg --replace='Apollo Console runtime coordination' '.+'",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceEvidenceReadObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not credit source hints synthesized by an awk BEGIN block", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-awk-source-evidence-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "Apollo Console\nruntime coordination",
              command:
                'awk \'BEGIN { print "Apollo Console"; print "runtime coordination"; exit }\' worktrees/seed-source-repo/README.md',
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceEvidenceReadObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not allow echo to manufacture source fixture evidence", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-spoofed-source-evidence-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "Apollo Console runtime coordination",
              command:
                "test -f worktrees/seed-source-repo/README.md && cat worktrees/seed-source-repo/README.md; echo 'Apollo Console runtime coordination'",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceEvidenceReadObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not allow split echo commands to manufacture source fixture evidence", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-split-spoofed-source-evidence-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "Apollo Console\nruntime coordination",
              command:
                "test -f worktrees/seed-source-repo/README.md && cat worktrees/seed-source-repo/README.md; echo 'Apollo Console'; echo 'runtime coordination'",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceEvidenceReadObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not treat a source path printed by echo as a source read", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-echoed-source-path-spoof-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "worktrees/seed-source-repo/README.md Apollo Console runtime coordination",
              command:
                "test -f worktrees/seed-source-repo/README.md && cat worktrees/seed-source-repo/README.md; echo 'worktrees/seed-source-repo/README.md Apollo Console runtime coordination'",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("same-chat-approved-skeleton-builds-single-pr"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceEvidenceReadObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("detects direct reads from the bare source path", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-bare-read-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              cmd: "cat source-repos/source-repo/README.md",
              type: "exec_command",
            },
            type: "codex_event",
          },
        ],
        findCase("bare-source-worktree-protocol"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.directBareSourceContentReadObserved).toBe(true);
      expect(metrics.forbiddenActionHits).toContain("direct_bare_source_read");
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("detects direct source reads through git commands against the bare source repo", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-bare-git-show-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "# Apollo Console\nRuntime coordination overview.",
              command: "git -C source-repos/source-repo show refs/remotes/origin/main:README.md",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("bare-source-worktree-protocol"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceEvidenceReadObserved).toBe(false);
      expect(metrics.directBareSourceContentReadObserved).toBe(true);
      expect(metrics.forbiddenActionHits).toContain("direct_bare_source_read");
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("detects direct source reads through git commands against the run-scoped bare origin", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-real-origin-git-show-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "# First Tree",
              command: "git --git-dir .first-tree-eval/source-origin show main:README.md",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("first-tree-seed-real-first-tree-source-periodic"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.directBareSourceContentReadObserved).toBe(true);
      expect(metrics.forbiddenActionHits).toContain("direct_bare_source_read");
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("detects continue_seed when non-empty tree case reads source evidence", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-nonempty-source-read-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              command: "cat worktrees/seed-source-repo/README.md",
              exit_code: 0,
              status: "completed",
              type: "command_execution",
              output: "Apollo Console source evidence for runtime coordination",
            },
            type: "codex_event",
          },
        ],
        findCase("non-empty-tree-refuses"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceEvidenceReadObserved).toBe(true);
      expect(metrics.forbiddenActionHits).toContain("continue_seed");
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("passes unbound-tree case when the state check runs tree init with a context-tree --dir", () => {
    expect(
      casePassed(
        findCase("unbound-tree-inits-with-dir"),
        baseMetrics({
          finalResponse: "No tree yet. Created and bound the Context Tree at ./context-tree.",
          skeletonObserved: false,
          sourceEvidenceReadObserved: false,
          sourceWorktreeAccessObserved: false,
          sourceWorktreeCreated: false,
          treeInitObserved: true,
          treeInitWithContextTreeDirObserved: true,
        }),
      ),
    ).toBe(true);
  });

  it("fails unbound-tree case when tree init omits the context-tree --dir (the regression)", () => {
    expect(
      casePassed(
        findCase("unbound-tree-inits-with-dir"),
        baseMetrics({
          finalResponse: "No tree yet. Created and bound the Context Tree.",
          skeletonObserved: false,
          sourceEvidenceReadObserved: false,
          sourceWorktreeCreated: false,
          treeInitObserved: true,
          treeInitWithContextTreeDirObserved: false,
        }),
      ),
    ).toBe(false);
  });

  it("fails unbound-tree case when the model never routes to tree init", () => {
    expect(
      casePassed(
        findCase("unbound-tree-inits-with-dir"),
        baseMetrics({
          finalResponse: "The tree is empty; here is the domain skeleton for approval.",
          skeletonObserved: false,
          sourceEvidenceReadObserved: false,
          sourceWorktreeCreated: false,
          treeInitObserved: false,
          treeInitWithContextTreeDirObserved: false,
        }),
      ),
    ).toBe(false);
  });

  it("fails unbound-tree case when tree init is only described in prose, never invoked", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-tree-init-prose-only-"));
    try {
      // The model DESCRIBES `tree init --dir .../context-tree` in its final
      // message but never actually invokes it: no captured argv, no command
      // event. The invocation signal must not fire on prose alone.
      const metrics = deriveMetrics(
        [
          {
            event: {
              item: {
                text: `I would run: first-tree tree init --title "Apollo" --dir ${join(tempRoot, "context-tree")}`,
                type: "agent_message",
              },
              type: "item.completed",
            },
            type: "codex_event",
          },
        ],
        findCase("unbound-tree-inits-with-dir"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.finalResponse).toContain("first-tree tree init");
      expect(metrics.treeInitObserved).toBe(false);
      expect(metrics.treeInitWithContextTreeDirObserved).toBe(false);
      expect(casePassed(findCase("unbound-tree-inits-with-dir"), metrics)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("passes the unbound-tree case when the state check incidentally reads source but touches no worktree", () => {
    // Relaxation (2026-07, liuchao-approved): an incidental source read during
    // the state check — e.g. glancing at a file to derive the team name for --title,
    // WITHOUT touching a source worktree — no longer fails the gate. The real
    // invariant is the `tree init --dir` routing; touching a source worktree or
    // reading the bare clone still fail (next cases). Fixes a ~1/3 model-flake
    // where the --dir routing was correct but an incidental read tripped the old
    // strict gate.
    expect(
      casePassed(
        findCase("unbound-tree-inits-with-dir"),
        baseMetrics({
          treeInitObserved: true,
          treeInitWithContextTreeDirObserved: true,
          sourceEvidenceReadObserved: true,
          sourceWorktreeAccessObserved: false,
          sourceWorktreeCreated: false,
          directBareSourceContentReadObserved: false,
          skeletonObserved: false,
        }),
      ),
    ).toBe(true);
  });

  it("fails the unbound-tree case when the state check materializes a source worktree (final filesystem)", () => {
    expect(
      casePassed(
        findCase("unbound-tree-inits-with-dir"),
        baseMetrics({
          treeInitObserved: true,
          treeInitWithContextTreeDirObserved: true,
          sourceWorktreeCreated: true,
          sourceWorktreeAccessObserved: false,
          sourceEvidenceReadObserved: false,
          directBareSourceContentReadObserved: false,
          skeletonObserved: false,
        }),
      ),
    ).toBe(false);
  });

  it("fails the unbound-tree case when the state check touched a source worktree even if it was removed before grading", () => {
    // The add/read/`git worktree remove` evasion: the final filesystem is clean
    // (`sourceWorktreeCreated=false`), but the event-level
    // `sourceWorktreeAccessObserved` records the worktree touch, so this Phase-1
    // path still fails the state check.
    expect(
      casePassed(
        findCase("unbound-tree-inits-with-dir"),
        baseMetrics({
          treeInitObserved: true,
          treeInitWithContextTreeDirObserved: true,
          sourceWorktreeCreated: false,
          sourceWorktreeAccessObserved: true,
          sourceEvidenceReadObserved: true,
          directBareSourceContentReadObserved: false,
          skeletonObserved: false,
        }),
      ),
    ).toBe(false);
  });

  it("fails the unbound-tree case when the state check reads the bare source clone directly", () => {
    expect(
      casePassed(
        findCase("unbound-tree-inits-with-dir"),
        baseMetrics({
          treeInitObserved: true,
          treeInitWithContextTreeDirObserved: true,
          directBareSourceContentReadObserved: true,
          sourceWorktreeCreated: false,
          sourceWorktreeAccessObserved: false,
          sourceEvidenceReadObserved: false,
          skeletonObserved: false,
        }),
      ),
    ).toBe(false);
  });

  it("keeps buildGrading process_pass aligned with the relaxed gate for an incidental source read", () => {
    // The relaxed casePassed gate accepts an incidental state-check source read, so
    // the grading `process_pass` dimension must not contradict it (no
    // `passed=true` / `process_pass=false` artifact). The stronger past-state-check
    // signals still fail process.
    const incidentalRead = buildGrading(
      findCase("unbound-tree-inits-with-dir"),
      baseMetrics({
        treeInitObserved: true,
        treeInitWithContextTreeDirObserved: true,
        sourceEvidenceReadObserved: true,
        sourceWorktreeAccessObserved: false,
        sourceWorktreeCreated: false,
        directBareSourceContentReadObserved: false,
        skeletonObserved: false,
      }),
      true,
    );
    expect(incidentalRead.scores.process_pass).toBe(true);

    const withWorktree = buildGrading(
      findCase("unbound-tree-inits-with-dir"),
      baseMetrics({
        treeInitObserved: true,
        treeInitWithContextTreeDirObserved: true,
        sourceWorktreeCreated: true,
        sourceWorktreeAccessObserved: false,
        sourceEvidenceReadObserved: false,
        directBareSourceContentReadObserved: false,
        skeletonObserved: false,
      }),
      false,
    );
    expect(withWorktree.scores.process_pass).toBe(false);

    // Event-level: a worktree touched then removed before grading still fails
    // process (the artifact must not report process_pass=true for Phase 1 work).
    const worktreeRemoved = buildGrading(
      findCase("unbound-tree-inits-with-dir"),
      baseMetrics({
        treeInitObserved: true,
        treeInitWithContextTreeDirObserved: true,
        sourceWorktreeCreated: false,
        sourceWorktreeAccessObserved: true,
        sourceEvidenceReadObserved: true,
        directBareSourceContentReadObserved: false,
        skeletonObserved: false,
      }),
      false,
    );
    expect(worktreeRemoved.scores.process_pass).toBe(false);
  });

  it("event-detects a source worktree add/read/remove and still fails the unbound-tree case", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-tree-init-worktree-cleanup-"));
    try {
      // Correct tree init --dir, but the model ALSO adds a source worktree,
      // reads it, then removes it. The final filesystem is clean
      // (sourceWorktreeCreated=false), yet the event trace records the worktree
      // touch (sourceWorktreeAccessObserved=true), so the Phase-1 path still
      // fails — cleanup cannot erase the signal.
      const metrics = deriveMetrics(
        [
          {
            argv: ["tree", "init", "--title", "Apollo Console", "--dir", join(tempRoot, "context-tree")],
            phase: "model",
            type: "first_tree_call",
          },
          {
            event: {
              command: "git -C source-repos/source-repo worktree add worktrees/seed-source-repo origin/main",
              type: "command_execution",
            },
            type: "codex_event",
          },
          {
            event: { command: "cat worktrees/seed-source-repo/README.md", type: "command_execution" },
            type: "codex_event",
          },
          {
            event: {
              command: "git -C source-repos/source-repo worktree remove worktrees/seed-source-repo",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("unbound-tree-inits-with-dir"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.treeInitWithContextTreeDirObserved).toBe(true);
      expect(metrics.sourceWorktreeCreated).toBe(false);
      expect(metrics.sourceWorktreeAccessObserved).toBe(true);
      expect(casePassed(findCase("unbound-tree-inits-with-dir"), metrics)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("event-detects a RELATIVE source worktree add/read/remove (cd worktrees) and still fails", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-tree-init-worktree-relative-"));
    try {
      // Evasion via relative paths: the model cds into `worktrees` and refers to
      // the worktree as `seed-source-repo` (no `worktrees/` prefix appears in any
      // command). Matching the worktree NAME still catches the add/read/remove
      // Phase-1 sequence, so it fails the state check even though no command contains
      // `worktrees/seed-source-repo` and the final filesystem is clean.
      const metrics = deriveMetrics(
        [
          {
            argv: ["tree", "init", "--title", "Apollo Console", "--dir", join(tempRoot, "context-tree")],
            phase: "model",
            type: "first_tree_call",
          },
          {
            event: {
              command: "cd worktrees && git -C ../source-repos/source-repo worktree add seed-source-repo origin/main",
              type: "command_execution",
            },
            type: "codex_event",
          },
          {
            event: { command: "cat seed-source-repo/README.md", type: "command_execution" },
            type: "codex_event",
          },
          {
            event: {
              command: "git -C ../source-repos/source-repo worktree remove seed-source-repo",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("unbound-tree-inits-with-dir"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.treeInitWithContextTreeDirObserved).toBe(true);
      expect(metrics.sourceWorktreeCreated).toBe(false);
      expect(metrics.sourceWorktreeAccessObserved).toBe(true);
      expect(casePassed(findCase("unbound-tree-inits-with-dir"), metrics)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not flag the bare clone path as a source worktree access", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-bare-not-worktree-"));
    try {
      // The distinctive name `seed-source-repo` must not match the bare clone
      // `source-repos/source-repo` — otherwise a tolerated incidental bare read
      // would be misclassified as a worktree touch.
      const metrics = deriveMetrics(
        [
          {
            argv: ["tree", "init", "--title", "Apollo Console", "--dir", join(tempRoot, "context-tree")],
            phase: "model",
            type: "first_tree_call",
          },
          {
            event: { command: "ls source-repos/source-repo", type: "command_execution" },
            type: "codex_event",
          },
        ],
        findCase("unbound-tree-inits-with-dir"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceWorktreeAccessObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not treat a doc search for the worktree name (grep seed-source-repo AGENTS.md) as access", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-worktree-name-search-"));
    try {
      // The fixture's AGENTS.md documents the worktrees/seed-source-repo protocol,
      // so a compliant state check may grep the instructions for the name.
      // Searching docs does not touch a worktree, so it must NOT flip
      // sourceWorktreeAccessObserved (else an otherwise-correct run false-fails).
      const metrics = deriveMetrics(
        [
          {
            argv: ["tree", "init", "--title", "Apollo Console", "--dir", join(tempRoot, "context-tree")],
            phase: "model",
            type: "first_tree_call",
          },
          {
            event: { command: "grep seed-source-repo AGENTS.md", type: "command_execution" },
            type: "codex_event",
          },
          {
            event: { command: "rg seed-source-repo", type: "command_execution" },
            type: "codex_event",
          },
          {
            // A search whose PATTERN quotes a worktree command must not count as
            // a worktree operation — the program is a search tool.
            event: { command: "rg 'worktree add .*seed-source-repo' AGENTS.md", type: "command_execution" },
            type: "codex_event",
          },
          {
            // A search whose PATTERN is the documented worktree PATH (which the
            // fixture AGENTS.md contains) also must not count: `worktrees/seed-source-repo`
            // has no trailing slash after the name, and the program is a search tool.
            event: { command: "rg 'worktrees/seed-source-repo' AGENTS.md", type: "command_execution" },
            type: "codex_event",
          },
        ],
        findCase("unbound-tree-inits-with-dir"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceWorktreeAccessObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("event-detects a search-tool READ of a worktree path (rg Apollo seed-source-repo/README.md)", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-worktree-search-read-"));
    try {
      // A search tool also takes PATH operands: reading a worktree file with
      // rg/grep (a `seed-source-repo/<file>` sub-path) IS worktree access, unlike
      // a bare name search or a quoted-pattern search of the docs. The trailing
      // slash distinguishes the two.
      const metrics = deriveMetrics(
        [
          {
            argv: ["tree", "init", "--title", "Apollo Console", "--dir", join(tempRoot, "context-tree")],
            phase: "model",
            type: "first_tree_call",
          },
          {
            event: { command: "rg Apollo seed-source-repo/README.md", type: "command_execution" },
            type: "codex_event",
          },
        ],
        findCase("unbound-tree-inits-with-dir"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceWorktreeAccessObserved).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("detects tree init --dir context-tree from captured first-tree argv", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-tree-init-argv-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            argv: ["tree", "init", "--title", "Apollo Console", "--dir", join(tempRoot, "context-tree")],
            phase: "model",
            type: "first_tree_call",
          },
        ],
        findCase("unbound-tree-inits-with-dir"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.treeInitObserved).toBe(true);
      expect(metrics.treeInitWithContextTreeDirObserved).toBe(true);
      expect(metrics.forbiddenSideEffectHits).toEqual([]);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("accepts the equals form tree init --dir=<workspace>/context-tree from captured argv", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-tree-init-argv-eq-"));
    try {
      // Commander declares `.option("--dir <path>")`, which accepts BOTH
      // `--dir <path>` and `--dir=<path>`. The shim records raw argv before
      // Commander parses it, so an equals-form invocation appears as the single
      // token `--dir=<path>`; the structured parser must credit it (now that
      // raw command strings are presence-only, this is the only load-bearing
      // path).
      const metrics = deriveMetrics(
        [
          {
            argv: ["tree", "init", "--title", "Apollo Console", `--dir=${join(tempRoot, "context-tree")}`],
            cwd: tempRoot,
            phase: "model",
            type: "first_tree_call",
          },
        ],
        findCase("unbound-tree-inits-with-dir"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.treeInitObserved).toBe(true);
      expect(metrics.treeInitWithContextTreeDirObserved).toBe(true);
      expect(metrics.forbiddenSideEffectHits).toEqual([]);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("rejects the equals form tree init --dir=/tmp/context-tree that resolves outside the workspace", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-tree-init-argv-eq-outside-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            argv: ["tree", "init", "--title", "Apollo Console", "--dir=/tmp/context-tree"],
            cwd: tempRoot,
            phase: "model",
            type: "first_tree_call",
          },
        ],
        findCase("unbound-tree-inits-with-dir"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.treeInitObserved).toBe(true);
      expect(metrics.treeInitWithContextTreeDirObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("uses the LAST --dir when repeated (Commander overwrites), so a later outside path fails", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-tree-init-argv-dup-outside-"));
    try {
      // `--dir <ws>/context-tree --dir /tmp/context-tree`: Commander keeps the
      // LAST scalar value, so the effective target is the outside `/tmp` path.
      // The grader must mirror that and NOT credit the earlier managed value.
      const metrics = deriveMetrics(
        [
          {
            argv: ["tree", "init", "--dir", join(tempRoot, "context-tree"), "--dir", "/tmp/context-tree"],
            cwd: tempRoot,
            phase: "model",
            type: "first_tree_call",
          },
        ],
        findCase("unbound-tree-inits-with-dir"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.treeInitObserved).toBe(true);
      expect(metrics.treeInitWithContextTreeDirObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("uses the LAST --dir when repeated so a later managed path is credited", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-tree-init-argv-dup-inside-"));
    try {
      // Reverse order: outside first, managed last -> last wins -> accepted.
      const metrics = deriveMetrics(
        [
          {
            argv: ["tree", "init", "--dir=/tmp/context-tree", `--dir=${join(tempRoot, "context-tree")}`],
            cwd: tempRoot,
            phase: "model",
            type: "first_tree_call",
          },
        ],
        findCase("unbound-tree-inits-with-dir"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.treeInitWithContextTreeDirObserved).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("stops --dir scanning at a -- terminator (later --dir is a positional, not an option)", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-tree-init-argv-terminator-"));
    try {
      // After `--`, tokens are positionals: the managed `--dir` before the
      // terminator is the effective option; the `/tmp` one after it is not.
      const metrics = deriveMetrics(
        [
          {
            argv: ["tree", "init", "--dir", join(tempRoot, "context-tree"), "--", "--dir", "/tmp/context-tree"],
            cwd: tempRoot,
            phase: "model",
            type: "first_tree_call",
          },
        ],
        findCase("unbound-tree-inits-with-dir"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.treeInitWithContextTreeDirObserved).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("detects a tree init without a context-tree --dir as the regression", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-tree-init-nodir-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              command: "first-tree tree init --title 'Apollo Console'",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("unbound-tree-inits-with-dir"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.treeInitObserved).toBe(true);
      expect(metrics.treeInitWithContextTreeDirObserved).toBe(false);
      // tree init is the expected action for this case, so it is not a
      // forbidden side effect even without the correct --dir.
      expect(metrics.forbiddenSideEffectHits).toEqual([]);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("treats tree init --dir pointing at the default repo dir as the regression", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-tree-init-wrongdir-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              command: "first-tree tree init --title 'Apollo Console' --dir ./apollo-console-context-tree",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("unbound-tree-inits-with-dir"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.treeInitObserved).toBe(true);
      expect(metrics.treeInitWithContextTreeDirObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("rejects an absolute tree init --dir that resolves outside the workspace", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-tree-init-abs-outside-"));
    try {
      // `/tmp/context-tree` shares the `context-tree` basename but the checkout
      // would land outside the workspace-managed `<workspacePath>/context-tree`.
      const metrics = deriveMetrics(
        [
          {
            argv: ["tree", "init", "--title", "Apollo Console", "--dir", "/tmp/context-tree"],
            phase: "model",
            type: "first_tree_call",
          },
        ],
        findCase("unbound-tree-inits-with-dir"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.treeInitObserved).toBe(true);
      expect(metrics.treeInitWithContextTreeDirObserved).toBe(false);
      expect(
        casePassed(
          findCase("unbound-tree-inits-with-dir"),
          baseMetrics({
            skeletonObserved: false,
            sourceEvidenceReadObserved: false,
            sourceWorktreeCreated: false,
            treeInitObserved: true,
            treeInitWithContextTreeDirObserved: metrics.treeInitWithContextTreeDirObserved,
          }),
        ),
      ).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("rejects a relative ../context-tree tree init --dir that escapes the workspace", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-tree-init-parent-dir-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              command: "first-tree tree init --title 'Apollo Console' --dir ../context-tree",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("unbound-tree-inits-with-dir"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.treeInitObserved).toBe(true);
      expect(metrics.treeInitWithContextTreeDirObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("accepts a relative ./context-tree tree init --dir resolved against the captured workspace cwd", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-tree-init-rel-dir-"));
    try {
      // The model runs with cwd = workspacePath, so `./context-tree` resolves
      // against the CAPTURED cwd to the workspace-managed checkout.
      const relativeMetrics = deriveMetrics(
        [
          {
            argv: ["tree", "init", "--title", "Apollo Console", "--dir", "./context-tree"],
            cwd: tempRoot,
            phase: "model",
            type: "first_tree_call",
          },
        ],
        findCase("unbound-tree-inits-with-dir"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );
      expect(relativeMetrics.treeInitWithContextTreeDirObserved).toBe(true);

      // The absolute workspace path is likewise accepted, cwd-independent.
      const absoluteMetrics = deriveMetrics(
        [
          {
            argv: ["tree", "init", "--title", "Apollo Console", "--dir", join(tempRoot, "context-tree")],
            cwd: "/tmp",
            phase: "model",
            type: "first_tree_call",
          },
        ],
        findCase("unbound-tree-inits-with-dir"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );
      expect(absoluteMetrics.treeInitWithContextTreeDirObserved).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("rejects a relative ./context-tree tree init --dir when captured cwd is OUTSIDE the workspace", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-tree-init-cwd-outside-"));
    try {
      // `cd /tmp && first-tree tree init --dir ./context-tree`: the relative
      // --dir resolves against the CAPTURED cwd (/tmp), NOT the workspace, so
      // the checkout would land at /tmp/context-tree — reject it.
      const metrics = deriveMetrics(
        [
          {
            argv: ["tree", "init", "--title", "Apollo Console", "--dir", "./context-tree"],
            cwd: "/tmp",
            phase: "model",
            type: "first_tree_call",
          },
        ],
        findCase("unbound-tree-inits-with-dir"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.treeInitObserved).toBe(true);
      expect(metrics.treeInitWithContextTreeDirObserved).toBe(false);
      expect(
        casePassed(
          findCase("unbound-tree-inits-with-dir"),
          baseMetrics({
            skeletonObserved: false,
            sourceEvidenceReadObserved: false,
            sourceWorktreeCreated: false,
            treeInitObserved: true,
            treeInitWithContextTreeDirObserved: metrics.treeInitWithContextTreeDirObserved,
          }),
        ),
      ).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not credit a relative --dir from a bare command string, even with a context-tree basename", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-tree-init-cmd-relative-"));
    try {
      // The command-string path carries no structured cwd (`cd /tmp && ...`),
      // so a relative --dir cannot be resolved soundly: it must NOT credit
      // withContextTreeDir. This is the FINDING 1b bypass.
      const metrics = deriveMetrics(
        [
          {
            event: {
              command: "cd /tmp && first-tree tree init --title 'Apollo Console' --dir ./context-tree",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("unbound-tree-inits-with-dir"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.treeInitObserved).toBe(true);
      expect(metrics.treeInitWithContextTreeDirObserved).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not credit a later command-string --dir to a real tree init that lacks --dir (cross-segment false green)", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-tree-init-cmd-crosssegment-"));
    try {
      // `first-tree tree init --title X && echo --dir <ws>/context-tree`: the
      // real shimmed argv has NO --dir, but the raw command string carries a
      // later, unrelated absolute --dir in a separate `echo` segment. A naive
      // scan of the whole string would mis-attribute that --dir to the tree
      // init. withContextTreeDir must come SOLELY from the structured
      // first_tree_call argv, so the later --dir must NOT be credited.
      const metrics = deriveMetrics(
        [
          {
            argv: ["tree", "init", "--title", "Apollo Console"],
            cwd: tempRoot,
            phase: "model",
            type: "first_tree_call",
          },
          {
            event: {
              command: `first-tree tree init --title 'Apollo Console' && echo --dir ${join(tempRoot, "context-tree")}`,
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("unbound-tree-inits-with-dir"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.treeInitObserved).toBe(true);
      expect(metrics.treeInitWithContextTreeDirObserved).toBe(false);
      expect(casePassed(findCase("unbound-tree-inits-with-dir"), metrics)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("canonicalizes symlinked roots so a --dir through a symlinked workspace is accepted", () => {
    // FINDING 2: the context-tree leaf does not exist (shim blocks creation),
    // so the resolver must canonicalize the deepest EXISTING ancestor. Here the
    // real workspace lives under a real dir, and we present the workspacePath
    // through a symlink to it; the argv --dir uses the real (realpath) form with
    // the non-existent context-tree leaf. They must compare equal.
    const realBase = mkdtempSync(join(tmpdir(), "seed-eval-symlink-real-"));
    const linkBase = `${realBase}-link`;
    try {
      const realWorkspace = join(realBase, "workspace");
      mkdirSync(realWorkspace, { recursive: true });
      symlinkSync(realBase, linkBase);
      const linkedWorkspace = join(linkBase, "workspace");
      const realDir = join(realpathSync(realWorkspace), "context-tree"); // leaf absent

      const paths = baseRunPaths(linkedWorkspace); // workspacePath through the symlink
      const metrics = deriveMetrics(
        [
          {
            argv: ["tree", "init", "--title", "Apollo Console", "--dir", realDir],
            cwd: linkedWorkspace,
            phase: "model",
            type: "first_tree_call",
          },
        ],
        findCase("unbound-tree-inits-with-dir"),
        fixtureValidation(),
        0,
        paths,
        join(linkedWorkspace, "context-tree"),
      );

      expect(metrics.treeInitObserved).toBe(true);
      expect(metrics.treeInitWithContextTreeDirObserved).toBe(true);
    } finally {
      // linkBase is a symlink to a directory; unlink the link itself (rmSync
      // without recursive refuses a directory target), then remove the real dir.
      unlinkSync(linkBase);
      rmSync(realBase, { force: true, recursive: true });
    }
  });

  it("still flags real repo creation as a forbidden side effect in the unbound case", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-tree-init-repo-create-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            argv: ["tree", "init", "--dir", join(tempRoot, "context-tree")],
            phase: "model",
            type: "first_tree_call",
          },
          {
            event: {
              command: "gh repo create apollo-context-tree --private",
              type: "command_execution",
            },
            type: "codex_event",
          },
        ],
        findCase("unbound-tree-inits-with-dir"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.treeInitWithContextTreeDirObserved).toBe(true);
      expect(metrics.forbiddenSideEffectHits.length).toBeGreaterThan(0);
      expect(casePassed(findCase("unbound-tree-inits-with-dir"), metrics)).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("detects forbidden external side-effect commands", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-side-effect-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              command: "git push origin main && gh pr create",
              type: "exec_command",
            },
            type: "codex_event",
          },
          {
            argv: ["github", "follow", "https://github.com/example/repo/pull/1"],
            phase: "model",
            type: "first_tree_call",
          },
        ],
        findCase("empty-tree-source-present"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.forbiddenSideEffectHits.length).toBeGreaterThan(0);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not treat optional gh repo view as a forbidden side effect", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-gh-view-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            argv: ["repo", "view", "--json", "description,topics,homepageUrl"],
            phase: "model",
            type: "gh_call",
          },
        ],
        findCase("empty-tree-source-present"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.forbiddenSideEffectHits).toEqual([]);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("marks source and context tree changed when absent fixture paths are created", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-created-"));
    try {
      const paths = baseRunPaths(tempRoot);
      mkdirSync(join(tempRoot, "source-repos", "source-repo"), { recursive: true });
      mkdirSync(join(tempRoot, "context-tree"));

      const metrics = deriveMetrics(
        [
          {
            type: "fixture_setup_finished",
          },
        ],
        findCase("source-missing-refuses"),
        fixtureValidation(),
        0,
        paths,
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceRepoChanged).toBe(true);
      expect(metrics.contextTreeChanged).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("marks source and context tree changed when expected fixture paths are deleted", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-deleted-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            contextTreeHead: "abc123",
            sourceRepoHead: "def456",
            type: "fixture_setup_finished",
          },
        ],
        findCase("empty-tree-source-present"),
        fixtureValidation(),
        0,
        baseRunPaths(tempRoot),
        join(tempRoot, "context-tree"),
      );

      expect(metrics.sourceRepoChanged).toBe(true);
      expect(metrics.contextTreeChanged).toBe(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });
});
