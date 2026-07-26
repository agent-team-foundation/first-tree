import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createRunPaths } from "../../../core/paths.js";
import { createEvalReporter } from "../../../core/reporter.js";
import { FIRST_TREE_SEED_GATE_CASES } from "../cases.js";
import { setupFixture, sourceRemoteRef, validateFixture } from "../fixture.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

function gateCase(id: string) {
  const evalCase = FIRST_TREE_SEED_GATE_CASES.find((candidate) => candidate.id === id);
  if (!evalCase) throw new Error(`missing gate case: ${id}`);
  return evalCase;
}

describe("first-tree-seed chat-first fixtures", () => {
  it("materializes a chat-provided checkout while leaving manifest.sources empty", () => {
    const evalCase = gateCase("empty-manifest-chat-source");
    const paths = createRunPaths({ caseId: evalCase.id, packageRoot, startedAt: new Date().toISOString() });

    try {
      const reporter = createEvalReporter(evalCase.id, false);
      const contextTreePath = setupFixture(evalCase, paths, reporter);
      const manifest = JSON.parse(readFileSync(join(paths.workspacePath, ".first-tree", "workspace.json"), "utf8")) as {
        sources: string[];
      };
      const bare = execFileSync("git", ["rev-parse", "--is-bare-repository"], {
        cwd: join(paths.workspacePath, "provided-source"),
        encoding: "utf8",
      }).trim();

      expect(manifest.sources).toEqual([]);
      expect(bare).toBe("false");
      expect(validateFixture(paths, contextTreePath, evalCase, false, reporter).ok).toBe(true);
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  }, 20_000);

  it("materializes a GitLab source fixture on its non-main default branch", () => {
    const evalCase = gateCase("gitlab-non-main-source-worktree-protocol");
    const paths = createRunPaths({ caseId: evalCase.id, packageRoot, startedAt: new Date().toISOString() });

    try {
      const reporter = createEvalReporter(evalCase.id, false);
      const contextTreePath = setupFixture(evalCase, paths, reporter);
      const sourceRepoPath = join(paths.workspacePath, "source-repos", "source-repo");
      const remoteHead = execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
        cwd: sourceRepoPath,
        encoding: "utf8",
      }).trim();
      const sourceHead = execFileSync("git", ["rev-parse", sourceRemoteRef(evalCase)], {
        cwd: sourceRepoPath,
        encoding: "utf8",
      }).trim();
      const localHead = execFileSync("git", ["rev-parse", "refs/heads/trunk"], {
        cwd: sourceRepoPath,
        encoding: "utf8",
      }).trim();
      const agentsMarkdown = readFileSync(join(paths.workspacePath, "AGENTS.md"), "utf8");

      expect(remoteHead).toBe("refs/remotes/origin/trunk");
      expect(sourceHead).not.toBe("");
      expect(localHead).not.toBe(sourceHead);
      expect(agentsMarkdown).toContain("Source forge: gitlab");
      expect(agentsMarkdown).toContain("Source default branch: `trunk`");
      expect(agentsMarkdown).toContain("Declared source ref: `ref=trunk`");
      expect(agentsMarkdown).toContain("Local source branch state: `stale`");
      expect(agentsMarkdown).toContain("Runtime declaration: ref=trunk");
      expect(agentsMarkdown).not.toContain("worktree add");
      expect(agentsMarkdown).not.toContain("origin/trunk");
      expect(agentsMarkdown).not.toContain("origin/main");
      expect(validateFixture(paths, contextTreePath, evalCase, false, reporter).ok).toBe(true);
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  }, 20_000);

  it("materializes merged durable Phase 1 progress without a manifest or transcript", () => {
    const evalCase = gateCase("durable-phase2-new-process-continuation");
    const paths = createRunPaths({ caseId: evalCase.id, packageRoot, startedAt: new Date().toISOString() });

    try {
      const reporter = createEvalReporter(evalCase.id, false);
      const contextTreePath = setupFixture(evalCase, paths, reporter);
      const localHead = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: contextTreePath,
        encoding: "utf8",
      }).trim();
      const remoteHead = execFileSync("git", ["rev-parse", "origin/main"], {
        cwd: contextTreePath,
        encoding: "utf8",
      }).trim();
      const remoteDefault = execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
        cwd: contextTreePath,
        encoding: "utf8",
      }).trim();

      expect(existsSync(join(contextTreePath, "product", "onboarding", "NODE.md"))).toBe(true);
      expect(existsSync(join(contextTreePath, "product", "onboarding", "flow.md"))).toBe(false);
      const progress = readFileSync(join(contextTreePath, ".first-tree", "progress.md"), "utf8");
      expect(progress).toContain("<!-- first-tree-seed-progress:v1 -->");
      expect(progress).toContain("- [x] Seed Phase 1 structure");
      expect(progress).toContain("<!-- first-tree-seed-ledger:v1 -->");
      expect(progress).toContain('"teamId":"team-seed-eval"');
      expect(progress).toContain('"identity":"local:');
      expect(progress).toMatch(/"commit":"[0-9a-f]{40,64}"/u);
      const recordedSourceCommit = progress.match(/"commit":"([0-9a-f]{40,64})"/u)?.[1];
      const currentSourceCommit = execFileSync("git", ["rev-parse", "refs/remotes/origin/main"], {
        cwd: join(paths.workspacePath, "source-repos", "source-repo"),
        encoding: "utf8",
      }).trim();
      expect(recordedSourceCommit).toBeDefined();
      expect(recordedSourceCommit).not.toBe(currentSourceCommit);
      expect(
        execFileSync("git", ["cat-file", "-e", [recordedSourceCommit, "^{commit}"].join("")], {
          cwd: join(paths.workspacePath, "source-repos", "source-repo"),
        }),
      ).toBeInstanceOf(Buffer);
      expect(existsSync(join(paths.workspacePath, ".first-tree", "workspace.json"))).toBe(false);
      expect(existsSync(join(paths.workspacePath, ".first-tree-eval", "chat-history.md"))).toBe(false);
      expect(remoteHead).toBe(localHead);
      expect(remoteDefault).toBe("refs/remotes/origin/main");
      expect(validateFixture(paths, contextTreePath, evalCase, false, reporter).ok).toBe(true);
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  }, 20_000);

  it("materializes the Phase-1-shaped negative sibling without a durable Seed marker", () => {
    const evalCase = gateCase("phase1-shaped-tree-without-durable-progress-refuses");
    const paths = createRunPaths({ caseId: evalCase.id, packageRoot, startedAt: new Date().toISOString() });

    try {
      const reporter = createEvalReporter(evalCase.id, false);
      const contextTreePath = setupFixture(evalCase, paths, reporter);

      expect(existsSync(join(contextTreePath, "product", "onboarding", "NODE.md"))).toBe(true);
      expect(existsSync(join(paths.workspacePath, ".first-tree-eval", "chat-history.md"))).toBe(false);
      expect(readFileSync(join(contextTreePath, ".first-tree", "progress.md"), "utf8")).not.toContain(
        "first-tree-seed-progress:v1",
      );
      expect(validateFixture(paths, contextTreePath, evalCase, false, reporter).ok).toBe(true);
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  }, 20_000);
});
