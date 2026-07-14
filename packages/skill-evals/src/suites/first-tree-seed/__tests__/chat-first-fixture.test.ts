import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createRunPaths } from "../../../core/paths.js";
import { createEvalReporter } from "../../../core/reporter.js";
import { FIRST_TREE_SEED_GATE_CASES } from "../cases.js";
import { setupFixture, validateFixture } from "../fixture.js";

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

  it("keeps the tree empty while carrying same-chat skeleton approval", () => {
    const evalCase = gateCase("same-chat-approved-skeleton-builds-single-pr");
    const paths = createRunPaths({ caseId: evalCase.id, packageRoot, startedAt: new Date().toISOString() });

    try {
      const reporter = createEvalReporter(evalCase.id, false);
      const contextTreePath = setupFixture(evalCase, paths, reporter);
      expect(existsSync(join(contextTreePath, "product"))).toBe(false);
      expect(existsSync(join(contextTreePath, "system"))).toBe(false);
      const history = readFileSync(join(paths.workspacePath, ".first-tree-eval", "chat-history.md"), "utf8");
      expect(history).toContain("## Assistant — earlier turn");
      expect(history).toContain("## User — earlier turn");
      expect(history).toContain("Skeleton proposal");
      expect(history).toContain("Approved");
      expect(history).toContain("one reviewable PR");
      expect(history).not.toContain("merge it");
      expect(history).not.toContain("reply in this setup chat");
      expect(validateFixture(paths, contextTreePath, evalCase, false, reporter).ok).toBe(true);
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  }, 20_000);
});
