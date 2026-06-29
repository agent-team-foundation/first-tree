import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { firstTreeCommandLabel, resolveFirstTreeBin } from "../first-tree-bin.js";
import type { RunPaths } from "../types.js";

function pathsWithBinDir(binDir: string): RunPaths {
  const paths = {
    binDir,
    eventsPath: join(binDir, "events.jsonl"),
    gradingJsonPath: join(binDir, "grading.json"),
    packageRoot: binDir,
    repoRoot: binDir,
    runRoot: binDir,
    shellEnvDir: binDir,
    summaryJsonPath: join(binDir, "summary.json"),
    summaryMdPath: join(binDir, "summary.md"),
    workspacePath: binDir,
  };
  return paths;
}

function touch(path: string): void {
  writeFileSync(path, "#!/bin/sh\n", { mode: 0o755 });
}

describe("resolveFirstTreeBin", () => {
  it("prefers explicit eval override", () => {
    const binDir = mkdtempSync(join(tmpdir(), "first-tree-bin-override-"));

    expect(resolveFirstTreeBin(pathsWithBinDir(binDir), { FIRST_TREE_EVAL_FIRST_TREE_BIN: "/tmp/ft-custom" })).toBe(
      "/tmp/ft-custom",
    );
  });

  it("uses channel-aware shims from the run bin directory before the prod shim", () => {
    const binDir = mkdtempSync(join(tmpdir(), "first-tree-bin-shim-"));
    touch(join(binDir, "first-tree"));
    touch(join(binDir, "first-tree-staging"));

    expect(resolveFirstTreeBin(pathsWithBinDir(binDir), { PATH: "" })).toBe(join(binDir, "first-tree-staging"));
  });

  it("falls back to first-tree when no channel binary is resolvable", () => {
    const binDir = mkdtempSync(join(tmpdir(), "first-tree-bin-fallback-"));

    expect(resolveFirstTreeBin(pathsWithBinDir(binDir), { PATH: "" })).toBe("first-tree");
  });
});

describe("firstTreeCommandLabel", () => {
  it("labels absolute shim paths by executable name", () => {
    expect(firstTreeCommandLabel("/tmp/eval/bin/first-tree-staging")).toBe("first-tree-staging");
  });
});
