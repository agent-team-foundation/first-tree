import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readEvents } from "../events.js";
import { FIRST_TREE_EVAL_VERIFY_BIN, runFixtureVerify } from "../fixture-verify.js";
import { createRunPaths } from "../paths.js";
import { createEvalReporter } from "../reporter.js";

function tempPackageRoot(): string {
  return mkdtempSync(join(tmpdir(), "skill-evals-fixture-verify-test-"));
}

function writeExecutable(path: string, script: string): void {
  writeFileSync(path, script, "utf8");
  chmodSync(path, 0o755);
}

describe("fixture tree verify runner", () => {
  it("uses the per-run first-tree shim by absolute path by default", () => {
    const packageRoot = tempPackageRoot();
    try {
      const paths = createRunPaths({
        caseId: "fixture-verify-shim-test",
        packageRoot,
        startedAt: "2026-06-29T00:00:00.000Z",
      });
      const shimPath = join(paths.binDir, "first-tree");
      writeExecutable(
        shimPath,
        `#!/bin/sh
printf 'harness shim verify\\n'
exit 0
`,
      );

      const result = runFixtureVerify({
        caseId: "fixture-verify-shim-test",
        contextTreePath: join(paths.workspacePath, "context-tree"),
        paths,
        reporter: createEvalReporter("fixture-verify-shim-test", false),
        sourceEnv: { PATH: "" },
        verbose: false,
      });

      expect(result.exitCode).toBe(0);
      expect(result.command).toBe(shimPath);
      expect(result.stdout).toContain("harness shim verify");
      expect(readEvents(paths.eventsPath)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            command: shimPath,
            commandSource: "harness-shim",
            type: "fixture_validation_started",
          }),
        ]),
      );
    } finally {
      rmSync(packageRoot, { force: true, recursive: true });
    }
  });

  it("resolves an explicit channel verify binary without shadowing it with binDir shims", () => {
    const packageRoot = tempPackageRoot();
    try {
      const paths = createRunPaths({
        caseId: "fixture-verify-channel-test",
        packageRoot,
        startedAt: "2026-06-29T00:00:00.000Z",
      });
      const realBinDir = join(packageRoot, "real-bin");
      mkdirSync(realBinDir, { recursive: true });
      writeExecutable(
        join(paths.binDir, "first-tree-staging"),
        `#!/bin/sh
printf 'shadowed staging shim\\n'
exit 64
`,
      );
      writeExecutable(
        join(realBinDir, "first-tree-staging"),
        `#!/bin/sh
printf 'real staging verify\\n'
exit 0
`,
      );

      const result = runFixtureVerify({
        caseId: "fixture-verify-channel-test",
        contextTreePath: join(paths.workspacePath, "context-tree"),
        paths,
        reporter: createEvalReporter("fixture-verify-channel-test", false),
        sourceEnv: {
          [FIRST_TREE_EVAL_VERIFY_BIN]: "first-tree-staging",
          PATH: realBinDir,
        },
        verbose: false,
      });

      expect(result.exitCode).toBe(0);
      expect(result.command).toBe("first-tree-staging");
      expect(result.stdout).toContain("real staging verify");
      expect(result.stdout).not.toContain("shadowed staging shim");
      expect(readEvents(paths.eventsPath)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            command: "first-tree-staging",
            commandSource: "eval-verify-bin",
            type: "fixture_validation_finished",
          }),
        ]),
      );
    } finally {
      rmSync(packageRoot, { force: true, recursive: true });
    }
  });
});
