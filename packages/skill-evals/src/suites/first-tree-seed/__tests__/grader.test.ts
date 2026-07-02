import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
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
    sourceWorktreeAccessObserved: true,
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

  it("passes the unbound-tree case when Step 0 incidentally reads source but touches no worktree", () => {
    // Relaxation (2026-07, liuchao-approved): an incidental source read during
    // Step 0 — e.g. glancing at a file to derive the team name for --title,
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

  it("fails the unbound-tree case when Step 0 materializes a source worktree (final filesystem)", () => {
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

  it("fails the unbound-tree case when Step 0 touched a source worktree even if it was removed before grading", () => {
    // The add/read/`git worktree remove` evasion: the final filesystem is clean
    // (`sourceWorktreeCreated=false`), but the event-level
    // `sourceWorktreeAccessObserved` records the worktree touch, so this Phase-1
    // path still fails Step 0.
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

  it("fails the unbound-tree case when Step 0 reads the bare source clone directly", () => {
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
    // The relaxed casePassed gate accepts an incidental Step 0 source read, so
    // the grading `process_pass` dimension must not contradict it (no
    // `passed=true` / `process_pass=false` artifact). The stronger past-Step-0
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
      // Phase-1 sequence, so it fails Step 0 even though no command contains
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
      // so a compliant Step 0 self-check may grep the instructions for the name.
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
