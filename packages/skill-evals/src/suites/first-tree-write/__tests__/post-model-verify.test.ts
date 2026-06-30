import { rmSync } from "node:fs";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

import { writeText } from "../../../core/commands.js";
import { runFixtureVerify } from "../../../core/fixture-verify.js";
import { createRunPaths } from "../../../core/paths.js";
import { createEvalReporter } from "../../../core/reporter.js";
import { createFirstTreeShim } from "../../../core/shims/first-tree.js";
import { FIRST_TREE_WRITE_GATE_CASES } from "../cases.js";
import { setupFixture } from "../fixture.js";
import type { FirstTreeWriteEvalCase } from "../types.js";

function currentPackageRoot(): string {
  return basename(process.cwd()) === "skill-evals" ? process.cwd() : join(process.cwd(), "packages", "skill-evals");
}

function durableWriteCase(): FirstTreeWriteEvalCase {
  const evalCase = FIRST_TREE_WRITE_GATE_CASES.find((candidate) => candidate.id === "durable-source-writes");
  if (!evalCase) throw new Error("Missing durable-source-writes case");
  return evalCase;
}

function setupVerifyFixture(caseId: string): {
  contextTreePath: string;
  paths: ReturnType<typeof createRunPaths>;
} {
  const paths = createRunPaths({
    caseId,
    packageRoot: currentPackageRoot(),
    startedAt: "2026-06-30T00:00:00.000Z",
  });
  const reporter = createEvalReporter(caseId, false);
  createFirstTreeShim(paths);
  const contextTreePath = setupFixture(durableWriteCase(), paths, reporter);
  return { contextTreePath, paths };
}

function runPostModelVerify(caseId: string, paths: ReturnType<typeof createRunPaths>, contextTreePath: string) {
  return runFixtureVerify({
    caseId,
    contextTreePath,
    eventTypePrefix: "post_model_validation",
    paths,
    phase: "post_model_validation",
    reporter: createEvalReporter(caseId, false),
    verbose: false,
  });
}

describe("first-tree-write post-model verify", () => {
  it("fails with the real validator when a model writes a broken soft_links target", () => {
    const { contextTreePath, paths } = setupVerifyFixture("post-model-verify-soft-links");
    try {
      writeText(
        join(contextTreePath, "system", "context-management", "skill-eval-framework.md"),
        `---
title: "Skill Eval Framework"
owners: [eval-owner]
soft_links: [missing/context-node]
---

# Skill Eval Framework

This node keeps valid title and owners frontmatter, but its soft link target is broken.
`,
      );

      const result = runPostModelVerify("post-model-verify-soft-links", paths, contextTreePath);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("broken soft_links target");
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });

  it("fails with the real validator when a member node is missing required member fields", () => {
    const { contextTreePath, paths } = setupVerifyFixture("post-model-verify-member");
    try {
      writeText(
        join(contextTreePath, "members", "eval-owner", "NODE.md"),
        `---
title: "eval-owner"
owners: [eval-owner]
---

# eval-owner

This member node is missing member metadata that the real validator requires.
`,
      );

      const result = runPostModelVerify("post-model-verify-member", paths, contextTreePath);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("missing 'type' field");
      expect(result.stdout).toContain("missing or empty 'role' field");
      expect(result.stdout).toContain("missing 'domains' field");
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });

  it("fails with the real validator when the progress checklist has unchecked items", () => {
    const { contextTreePath, paths } = setupVerifyFixture("post-model-verify-progress");
    try {
      writeText(
        join(contextTreePath, ".first-tree", "progress.md"),
        `# Context Tree Progress

- [ ] finish binding the eval tree
`,
      );

      const result = runPostModelVerify("post-model-verify-progress", paths, contextTreePath);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("Unchecked progress item: finish binding the eval tree");
    } finally {
      rmSync(paths.runRoot, { force: true, recursive: true });
    }
  });
});
