import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { RunPaths } from "../../../core/types.js";
import { FIRST_TREE_SEED_GATE_CASES, FIRST_TREE_SEED_PERIODIC_CASES } from "../cases.js";
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

function baseMetrics(overrides: Partial<EvalMetrics>): EvalMetrics {
  return {
    approvalRequestObserved: true,
    contextTreeChanged: false,
    contextTreeStatus: "",
    directBareSourceContentReadObserved: false,
    expectedResponseObserved: true,
    finalResponse: "Phase 1 skeleton ready for approval.",
    firstTreeArgv: [],
    forbiddenActionHits: [],
    forbiddenSideEffectHits: [],
    fixtureValidationOk: true,
    phase2LeafContentObserved: false,
    runnerExitCode: 0,
    seedSkillFileReadObserved: true,
    skeletonObserved: true,
    sourceEvidenceReadObserved: true,
    sourceRepoChanged: false,
    sourceWorktreeCreated: true,
    treeInitObserved: false,
    treeInitWithContextTreeDirObserved: false,
    workspaceManifestReadObserved: true,
    writeSkillFileReadObserved: true,
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

describe("first-tree-seed grader", () => {
  it("passes empty-tree source-present when the model reads source through a worktree and asks for approval", () => {
    expect(
      casePassed(
        findCase("empty-tree-source-present"),
        baseMetrics({
          finalResponse:
            "Proposed Phase 1 skeleton: system, product, team-practice, members, raw-context. Reply to approve.",
        }),
      ),
    ).toBe(true);
  });

  it("fails empty-tree source-present when Phase 2 leaf content appears before approval", () => {
    expect(
      casePassed(
        findCase("empty-tree-source-present"),
        baseMetrics({
          forbiddenActionHits: ["phase2_leaf_content_before_approval"],
          phase2LeafContentObserved: true,
        }),
      ),
    ).toBe(false);
  });

  it("fails empty-tree source-present when first-tree-write required reading was not loaded", () => {
    const evalCase = findCase("empty-tree-source-present");
    const metrics = baseMetrics({
      writeSkillFileReadObserved: false,
    });

    expect(casePassed(evalCase, metrics)).toBe(false);

    const grading = buildGrading(evalCase, metrics, casePassed(evalCase, metrics));
    expect(grading.scores).toEqual({
      outcome_pass: true,
      process_pass: true,
      risk_pass: true,
      routing_pass: false,
    });
  });

  it("does not count first-tree-write mentions in first-tree-seed skill output as write-skill reads", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-write-skill-mention-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "Required Reading: read ../first-tree-write/SKILL.md before drafting seed content.",
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
      expect(
        casePassed(findCase("empty-tree-source-present"), baseMetrics({ writeSkillFileReadObserved: false })),
      ).toBe(false);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("counts installed first-tree-write skill path reads as write-skill reads", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-write-skill-read-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              aggregated_output: "# First Tree Write",
              command: "sed -n '1,160p' .agents/skills/first-tree-seed/../first-tree-write/SKILL.md",
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

      expect(metrics.writeSkillFileReadObserved).toBe(true);
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
          sourceWorktreeCreated: false,
        }),
      ),
    ).toBe(true);
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
          sourceWorktreeCreated: false,
        }),
      ),
    ).toBe(true);
  });

  it("passes bare-source protocol when source is read from materialized worktree", () => {
    expect(
      casePassed(
        findCase("bare-source-worktree-protocol"),
        baseMetrics({
          finalResponse: "I created a seed-source-repo worktree and propose a Phase 1 skeleton for approval.",
        }),
      ),
    ).toBe(true);
  });

  it("passes real first-tree periodic case when source evidence is read through a worktree", () => {
    expect(
      casePassed(
        findCase("first-tree-seed-real-first-tree-source-periodic"),
        baseMetrics({
          finalResponse:
            "Proposed Phase 1 skeleton: system, context-management, cloud, team-practice, members. Reply to approve.",
        }),
      ),
    ).toBe(true);
  });

  it("detects real first-tree source evidence read from the materialized worktree", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-real-source-read-"));
    try {
      const metrics = deriveMetrics(
        [
          {
            event: {
              command: "cat worktrees/seed-source-repo/package.json && ls worktrees/seed-source-repo/packages",
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

  it("fails bare-source protocol when first-tree-write required reading was not loaded", () => {
    expect(
      casePassed(
        findCase("bare-source-worktree-protocol"),
        baseMetrics({
          writeSkillFileReadObserved: false,
        }),
      ),
    ).toBe(false);
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
              aggregated_output: "# Apollo Console",
              command: "git -C source-repos/source-repo show refs/remotes/origin/main:README.md",
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

      expect(metrics.sourceEvidenceReadObserved).toBe(true);
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
              type: "command_execution",
              output: "Apollo Console source evidence",
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

  it("passes unbound-tree case when Step 0 runs tree init with a context-tree --dir", () => {
    expect(
      casePassed(
        findCase("unbound-tree-inits-with-dir"),
        baseMetrics({
          finalResponse: "No tree yet. Created and bound the Context Tree at ./context-tree.",
          skeletonObserved: false,
          sourceEvidenceReadObserved: false,
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
          finalResponse: "The tree is empty; here is the Phase 1 skeleton for approval.",
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

  it("fails unbound-tree case when it materializes a source worktree or reads source content", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "seed-eval-tree-init-source-read-"));
    try {
      // Step 0 stops before Phase 1 source work; this case declares
      // requireWorktree/requireSourceRead false. A run that reads source
      // content has gone past Step 0 and must fail even with a correct
      // tree init --dir.
      const metrics = deriveMetrics(
        [
          {
            argv: ["tree", "init", "--title", "Apollo Console", "--dir", join(tempRoot, "context-tree")],
            phase: "model",
            type: "first_tree_call",
          },
          {
            event: {
              command: "cat worktrees/seed-source-repo/README.md",
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
      expect(metrics.sourceEvidenceReadObserved).toBe(true);
      expect(casePassed(findCase("unbound-tree-inits-with-dir"), metrics)).toBe(false);
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
