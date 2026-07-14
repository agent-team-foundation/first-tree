import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { readEvents } from "../events.js";
import { createRunPaths } from "../paths.js";
import { createFirstTreeShim } from "../shims/first-tree.js";

describe("first-tree eval shim", () => {
  it("handles tree tree help without spawning the real CLI", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "skill-evals-first-tree-shim-test-"));
    try {
      const packageRoot = join(repoRoot, "packages", "skill-evals");
      mkdirSync(packageRoot, { recursive: true });
      const paths = createRunPaths({
        caseId: "first-tree-shim-tree-test",
        packageRoot,
        startedAt: "2026-06-30T00:00:00.000Z",
      });
      createFirstTreeShim(paths);

      const result = spawnSync(join(paths.binDir, "first-tree"), ["tree", "tree", "--help"], {
        cwd: paths.workspacePath,
        encoding: "utf8",
        env: {
          ...process.env,
          FIRST_TREE_EVAL_EVENTS: paths.eventsPath,
          FIRST_TREE_EVAL_PHASE: "model",
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: first-tree tree tree");
      expect(readEvents(paths.eventsPath)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            argv: ["tree", "tree", "--help"],
            exitCode: 0,
            shimmedByEval: true,
            type: "first_tree_result",
          }),
        ]),
      );
    } finally {
      rmSync(repoRoot, { force: true, recursive: true });
    }
  });

  it("allows governance seed cases to simulate tree init success", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "skill-evals-first-tree-shim-governance-"));
    try {
      const packageRoot = join(repoRoot, "packages", "skill-evals");
      mkdirSync(packageRoot, { recursive: true });
      const paths = createRunPaths({
        caseId: "unbound-github-tree-governance-bootstrap",
        packageRoot,
        startedAt: "2026-06-30T00:00:00.000Z",
      });
      createFirstTreeShim(paths);

      const result = spawnSync(join(paths.binDir, "first-tree"), ["tree", "init", "--dir", "context-tree"], {
        cwd: paths.workspacePath,
        encoding: "utf8",
        env: {
          ...process.env,
          FIRST_TREE_EVAL_CASE_ID: "unbound-github-tree-governance-bootstrap",
          FIRST_TREE_EVAL_EVENTS: paths.eventsPath,
          FIRST_TREE_EVAL_PHASE: "model",
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Created and bound Context Tree");
      expect(existsSync(join(paths.workspacePath, "context-tree", ".first-tree", "tree.json"))).toBe(true);
      expect(readEvents(paths.eventsPath)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            argv: ["tree", "init", "--dir", "context-tree"],
            exitCode: 0,
            governanceTreeInit: true,
            type: "first_tree_result",
          }),
        ]),
      );
    } finally {
      rmSync(repoRoot, { force: true, recursive: true });
    }
  });

  it("uses the built CLI entry when a command is not handled by the shim", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "skill-evals-first-tree-shim-test-"));
    try {
      const packageRoot = join(repoRoot, "packages", "skill-evals");
      const distCliDir = join(repoRoot, "apps", "cli", "dist", "cli");
      const tsxBinDir = join(packageRoot, "node_modules", ".bin");
      mkdirSync(distCliDir, { recursive: true });
      mkdirSync(tsxBinDir, { recursive: true });
      writeFileSync(
        join(distCliDir, "index.mjs"),
        "process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\\n');\n",
        "utf8",
      );
      const tsxBin = join(tsxBinDir, "tsx");
      writeFileSync(tsxBin, "#!/bin/sh\nexit 88\n", "utf8");
      chmodSync(tsxBin, 0o755);

      const paths = createRunPaths({
        caseId: "first-tree-shim-dist-test",
        packageRoot,
        startedAt: "2026-06-30T00:00:00.000Z",
      });
      createFirstTreeShim(paths);

      const result = spawnSync(join(paths.binDir, "first-tree"), ["version"], {
        cwd: paths.workspacePath,
        encoding: "utf8",
        env: {
          ...process.env,
          FIRST_TREE_EVAL_EVENTS: paths.eventsPath,
          FIRST_TREE_EVAL_PHASE: "model",
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(JSON.stringify(["version"]));
      expect(readEvents(paths.eventsPath)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            argv: ["version"],
            exitCode: 0,
            type: "first_tree_result",
          }),
        ]),
      );
    } finally {
      rmSync(repoRoot, { force: true, recursive: true });
    }
  });

  it("uses the built CLI entry for tree verify outside the model phase", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "skill-evals-first-tree-shim-test-"));
    try {
      const packageRoot = join(repoRoot, "packages", "skill-evals");
      const distCliDir = join(repoRoot, "apps", "cli", "dist", "cli");
      mkdirSync(distCliDir, { recursive: true });
      writeFileSync(
        join(distCliDir, "index.mjs"),
        "process.stdout.write('real verify ' + JSON.stringify(process.argv.slice(2)) + '\\n');\n",
        "utf8",
      );

      const paths = createRunPaths({
        caseId: "first-tree-shim-post-model-verify-test",
        packageRoot,
        startedAt: "2026-06-30T00:00:00.000Z",
      });
      createFirstTreeShim(paths);

      const result = spawnSync(join(paths.binDir, "first-tree"), ["tree", "verify", "--tree-path", "context-tree"], {
        cwd: paths.workspacePath,
        encoding: "utf8",
        env: {
          ...process.env,
          FIRST_TREE_EVAL_EVENTS: paths.eventsPath,
          FIRST_TREE_EVAL_PHASE: "post_model_validation",
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('real verify ["tree","verify","--tree-path","context-tree"]');
      const events = readEvents(paths.eventsPath);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            argv: ["tree", "verify", "--tree-path", "context-tree"],
            exitCode: 0,
            type: "first_tree_result",
          }),
        ]),
      );
      const resultEvent = events.find((event) => (event as { type?: string }).type === "first_tree_result");
      expect(resultEvent).not.toHaveProperty("shimmedByEval");
    } finally {
      rmSync(repoRoot, { force: true, recursive: true });
    }
  });
});
