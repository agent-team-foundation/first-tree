import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { runBind } from "#engine/bind.js";
import { Repo } from "#engine/repo.js";
import {
  readSourceState,
  readTreeBinding,
  readTreeState,
  treeBindingPath,
} from "#engine/runtime/binding-state.js";
import { makeGitRepo, makeSourceRepo, makeSourceSkill, makeTreeMetadata, useTmpDir } from "./helpers.js";

describe("runBind", () => {
  it("installs the tree-repo skill without creating a codebase submodule", () => {
    const sandbox = useTmpDir();
    const sourceBundle = useTmpDir();
    const sourceRoot = join(sandbox.path, "product-repo");
    const treeRoot = join(sandbox.path, "org-context");

    makeSourceRepo(sourceRoot);
    makeGitRepo(treeRoot);
    makeTreeMetadata(treeRoot, "0.1.0");
    makeSourceSkill(sourceBundle.path, "0.2.0");

    const result = runBind(new Repo(sourceRoot), {
      currentCwd: sourceRoot,
      sourceRoot: sourceBundle.path,
      treeMode: "shared",
      treePath: relative(sourceRoot, treeRoot),
    });

    const sourceState = readSourceState(sourceRoot);
    const treeBinding = readTreeBinding(treeRoot, sourceState!.sourceId);
    expect(result).toBe(0);
    expect(sourceState?.bindingMode).toBe("shared-source");
    expect(readTreeState(treeRoot)?.treeRepoName).toBe("org-context");
    expect(existsSync(join(treeRoot, ".agents", "skills", "first-tree", "SKILL.md"))).toBe(
      true,
    );
    expect(existsSync(join(treeRoot, ".claude", "skills", "first-tree", "SKILL.md"))).toBe(
      true,
    );
    expect(treeBinding?.sourceName).toBe("product-repo");
    expect(existsSync(join(treeRoot, ".gitmodules"))).toBe(false);
    expect(
      JSON.parse(
        readFileSync(treeBindingPath(treeRoot, sourceState!.sourceId), "utf-8"),
      ),
    ).not.toHaveProperty("submodulePath");
  });
});
