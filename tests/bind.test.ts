import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { runBind } from "#products/tree/engine/bind.js";
import { Repo } from "#products/tree/engine/repo.js";
import {
  readSourceState,
  readTreeBinding,
  readTreeState,
  treeBindingPath,
} from "#products/tree/engine/runtime/binding-state.js";
import { makeAgentsMd, makeGitRepo, makeSourceRepo, makeSourceSkill, makeTreeMetadata, useTmpDir } from "./helpers.js";

describe("runBind", () => {
  it("installs the tree-repo skill without creating a codebase submodule", () => {
    const sandbox = useTmpDir();
    const sourceBundle = useTmpDir();
    const sourceRoot = join(sandbox.path, "product-repo");
    const treeRoot = join(sandbox.path, "org-context");

    makeSourceRepo(sourceRoot);
    execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/product-repo.git"], {
      cwd: sourceRoot,
      stdio: "ignore",
    });
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
    expect(existsSync(join(sourceRoot, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(sourceRoot, ".codex", "config.toml"))).toBe(true);
    expect(existsSync(join(sourceRoot, ".codex", "hooks.json"))).toBe(true);
    expect(existsSync(join(treeRoot, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(treeRoot, ".codex", "config.toml"))).toBe(true);
    expect(existsSync(join(treeRoot, ".codex", "hooks.json"))).toBe(true);
    expect(treeBinding?.sourceName).toBe("product-repo");
    expect(existsSync(join(treeRoot, ".gitmodules"))).toBe(false);
    expect(
      JSON.parse(
        readFileSync(treeBindingPath(treeRoot, sourceState!.sourceId), "utf-8"),
      ),
    ).not.toHaveProperty("submodulePath");
  });

  it("refreshes source-repos.md plus root tree guidance when a binding is written", () => {
    const sandbox = useTmpDir();
    const sourceBundle = useTmpDir();
    const sourceRoot = join(sandbox.path, "product-repo");
    const treeRoot = join(sandbox.path, "org-context");

    makeSourceRepo(sourceRoot);
    execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/product-repo.git"], {
      cwd: sourceRoot,
      stdio: "ignore",
    });
    makeGitRepo(treeRoot);
    makeTreeMetadata(treeRoot, "0.1.0");
    makeAgentsMd(treeRoot, { markers: true, userContent: true });
    writeFileSync(
      join(treeRoot, "NODE.md"),
      [
        "---",
        "title: Org Context",
        "owners: [alice]",
        "---",
        "",
        "# Org Context",
        "",
        "Shared context for the team.",
        "",
        "## Domains",
        "",
        "- **[members/](members/NODE.md)** — Team members.",
        "",
      ].join("\n"),
    );
    makeSourceSkill(sourceBundle.path, "0.2.0");

    const result = runBind(new Repo(sourceRoot), {
      currentCwd: sourceRoot,
      sourceRoot: sourceBundle.path,
      treeMode: "shared",
      treePath: relative(sourceRoot, treeRoot),
    });

    const sourceRepos = readFileSync(join(treeRoot, "source-repos.md"), "utf-8");
    const rootNode = readFileSync(join(treeRoot, "NODE.md"), "utf-8");
    const agents = readFileSync(join(treeRoot, "AGENTS.md"), "utf-8");

    expect(result).toBe(0);
    expect(sourceRepos).toContain("# Source Repos");
    expect(sourceRepos).toContain("[acme/product-repo](https://github.com/acme/product-repo)");
    expect(rootNode).toContain("## Source Repos");
    expect(rootNode).toContain("[Source Repos](source-repos.md)");
    expect(agents).toContain("## Source Repo Index");
    expect(agents).toContain("source-repos.md");
    expect(agents).toContain(".first-tree/bindings/");
  });
});
