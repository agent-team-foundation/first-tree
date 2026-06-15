import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalizeFsPath,
  contextTreeRelativePathOf,
  resolveContextTreeRelativePath,
  toolFileRefsFromShellCommand,
} from "../runtime/context-tree-file-refs.js";
import { clearGitRepoIdentityCacheForTests } from "../runtime/git-repo-identity.js";

describe("toolFileRefsFromShellCommand", () => {
  let root: string;
  let tree: string;
  let source: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "first-tree-shell-refs-"));
    tree = join(root, "context-tree");
    source = join(root, "source");
    mkdirSync(join(tree, "members", "alice"), { recursive: true });
    mkdirSync(join(tree, "roadmap"), { recursive: true });
    mkdirSync(source, { recursive: true });
    writeFileSync(join(tree, "NODE.md"), "root");
    writeFileSync(join(tree, "members", "alice", "NODE.md"), "member");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("maps a Codex-style sed read to one Context Tree file ref", () => {
    const refs = toolFileRefsFromShellCommand({
      command: `sed -n '1,240p' ${join(tree, "NODE.md")}`,
      cwd: source,
      contextTreePath: tree,
      contextTreeRepoUrl: "https://github.com/acme/first-tree-context.git",
      contextTreeBranch: "main",
    });

    expect(refs).toEqual([
      {
        origin: "tool_arg",
        localPath: join(tree, "NODE.md"),
        repoUrl: "https://github.com/acme/first-tree-context.git",
        repoBranch: "main",
        repoRelativePath: "NODE.md",
        pathKind: "file",
      },
    ]);
  });

  it("maps relative paths when cwd is inside the Context Tree", () => {
    const refs = toolFileRefsFromShellCommand({
      command: "cat members/alice/NODE.md",
      cwd: tree,
      contextTreePath: tree,
      contextTreeRepoUrl: "https://github.com/acme/first-tree-context.git",
    });

    expect(refs).toEqual([
      {
        origin: "tool_arg",
        localPath: join(tree, "members", "alice", "NODE.md"),
        repoUrl: "https://github.com/acme/first-tree-context.git",
        repoRelativePath: "members/alice/NODE.md",
        pathKind: "file",
      },
    ]);
  });

  it("emits a directory ref for rg files mode", () => {
    const refs = toolFileRefsFromShellCommand({
      command: `rg --files ${join(tree, "roadmap")}`,
      cwd: source,
      contextTreePath: tree,
      contextTreeRepoUrl: "https://github.com/acme/first-tree-context.git",
    });

    expect(refs).toEqual([
      {
        origin: "tool_arg",
        localPath: join(tree, "roadmap"),
        repoUrl: "https://github.com/acme/first-tree-context.git",
        repoRelativePath: "roadmap",
        pathKind: "directory",
      },
    ]);
  });

  it("rejects sibling-prefix paths outside the Context Tree root", () => {
    const sibling = join(root, "context-tree-other");
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "NODE.md"), "outside");

    expect(
      toolFileRefsFromShellCommand({
        command: `cat ${join(sibling, "NODE.md")}`,
        cwd: source,
        contextTreePath: tree,
        contextTreeRepoUrl: "https://github.com/acme/first-tree-context.git",
      }),
    ).toEqual([]);
  });

  it("rejects complex or mutating shell candidates", () => {
    const base = {
      cwd: source,
      contextTreePath: tree,
      contextTreeRepoUrl: "https://github.com/acme/first-tree-context.git",
    };

    expect(toolFileRefsFromShellCommand({ ...base, command: `cat ${join(tree, "NODE.md")} | head` })).toEqual([]);
    expect(toolFileRefsFromShellCommand({ ...base, command: `echo x > ${join(tree, "NODE.md")}` })).toEqual([]);
    expect(toolFileRefsFromShellCommand({ ...base, command: `tee ${join(tree, "NODE.md")}` })).toEqual([]);
    expect(toolFileRefsFromShellCommand({ ...base, command: `sed -i 's/a/b/' ${join(tree, "NODE.md")}` })).toEqual([]);
    expect(toolFileRefsFromShellCommand({ ...base, command: `find ${tree} -delete` })).toEqual([]);
    expect(toolFileRefsFromShellCommand({ ...base, command: `find ${tree} -exec rm {} \\;` })).toEqual([]);
  });

  it("does not emit refs for unquoted comment text when cwd is the Context Tree", () => {
    expect(
      toolFileRefsFromShellCommand({
        command: "cat NODE.md # members/alice/NODE.md",
        cwd: tree,
        contextTreePath: tree,
        contextTreeRepoUrl: "https://github.com/acme/first-tree-context.git",
      }),
    ).toEqual([]);
  });

  it("does not emit local-only refs when Context Tree binding evidence is missing", () => {
    expect(
      toolFileRefsFromShellCommand({
        command: `cat ${join(tree, "NODE.md")}`,
        cwd: source,
        contextTreePath: tree,
        contextTreeRepoUrl: null,
      }),
    ).toEqual([]);
  });
});

describe("canonicalizeFsPath / contextTreeRelativePathOf", () => {
  let root: string;
  let realTree: string;
  let link: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "first-tree-canonical-"));
    realTree = join(root, "context-tree-repos", "abc123");
    mkdirSync(join(realTree, "members"), { recursive: true });
    writeFileSync(join(realTree, "NODE.md"), "root");
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    link = join(workspace, "context-tree");
    symlinkSync(realTree, link);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves a symlinked path to its real form", () => {
    expect(canonicalizeFsPath(join(link, "NODE.md"))).toBe(canonicalizeFsPath(join(realTree, "NODE.md")));
  });

  it("canonicalizes the deepest existing ancestor of a not-yet-existing path", () => {
    expect(canonicalizeFsPath(join(link, "domains", "new-leaf.md"))).toBe(
      canonicalizeFsPath(join(realTree, "domains", "new-leaf.md")),
    );
  });

  it("relativizes across symlink aliases in both directions", () => {
    expect(contextTreeRelativePathOf(join(link, "members"), realTree)).toBe("members");
    expect(contextTreeRelativePathOf(join(realTree, "members"), link)).toBe("members");
    expect(contextTreeRelativePathOf(link, realTree)).toBe("/");
  });

  it("still rejects paths outside the tree", () => {
    expect(contextTreeRelativePathOf(join(root, "workspace"), realTree)).toBeNull();
  });

  it("maps shell reads that travel through the workspace symlink", () => {
    const refs = toolFileRefsFromShellCommand({
      command: `cat ${join(link, "NODE.md")}`,
      cwd: root,
      contextTreePath: realTree,
      contextTreeRepoUrl: "https://github.com/acme/first-tree-context.git",
      contextTreeBranch: "main",
    });

    expect(refs).toEqual([
      {
        origin: "tool_arg",
        localPath: join(link, "NODE.md"),
        repoUrl: "https://github.com/acme/first-tree-context.git",
        repoBranch: "main",
        repoRelativePath: "NODE.md",
        pathKind: "file",
      },
    ]);
  });
});

/**
 * Repo-identity attribution: tree writes are authored in per-task worktrees
 * (sibling checkouts of the same repo), not in the bound shared clone. Refs
 * must attribute by git remote identity, not just path containment.
 */
describe("resolveContextTreeRelativePath — tree PR worktree (repo identity)", () => {
  let root: string;
  let sharedClone: string;
  let treeWorktree: string;
  let sourceRepo: string;

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", ["-C", cwd, ...args])
      .toString("utf8")
      .trim();
  }

  beforeEach(() => {
    clearGitRepoIdentityCacheForTests();
    root = mkdtempSync(join(tmpdir(), "first-tree-repo-identity-refs-"));
    sharedClone = join(root, "context-tree-repos", "abc123");
    mkdirSync(sharedClone, { recursive: true });
    git(join(root, "context-tree-repos"), "init", "abc123");
    git(sharedClone, "config", "user.email", "agent@example.com");
    git(sharedClone, "config", "user.name", "Agent");
    git(sharedClone, "remote", "add", "origin", "git@github.com:acme/first-tree-context.git");
    writeFileSync(join(sharedClone, "NODE.md"), "root");
    git(sharedClone, "add", ".");
    git(sharedClone, "commit", "-m", "initial");

    treeWorktree = join(root, "worktrees", "task-tree");
    mkdirSync(join(root, "worktrees"), { recursive: true });
    git(sharedClone, "worktree", "add", treeWorktree, "-b", "task-branch");

    sourceRepo = join(root, "worktrees", "task-code");
    mkdirSync(sourceRepo, { recursive: true });
    git(join(root, "worktrees"), "init", "task-code");
    git(sourceRepo, "remote", "add", "origin", "https://github.com/acme/first-tree.git");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    clearGitRepoIdentityCacheForTests();
  });

  it("attributes a path inside a tree PR worktree via the worktree's remote", () => {
    expect(
      resolveContextTreeRelativePath(join(treeWorktree, "system", "new-node.md"), {
        contextTreePath: sharedClone,
        contextTreeRepoUrl: "https://github.com/acme/first-tree-context.git",
      }),
    ).toBe("system/new-node.md");
  });

  it("does not attribute paths in a checkout of a different repo", () => {
    expect(
      resolveContextTreeRelativePath(join(sourceRepo, "docs", "guide.md"), {
        contextTreePath: sharedClone,
        contextTreeRepoUrl: "https://github.com/acme/first-tree-context.git",
      }),
    ).toBeNull();
  });

  it("still resolves containment without spawning git (fast path)", () => {
    expect(
      resolveContextTreeRelativePath(join(sharedClone, "NODE.md"), {
        contextTreePath: sharedClone,
        contextTreeRepoUrl: null,
      }),
    ).toBe("NODE.md");
  });

  it("emits shell read refs for tree files read inside the tree PR worktree", () => {
    const refs = toolFileRefsFromShellCommand({
      command: `cat ${join(treeWorktree, "NODE.md")}`,
      cwd: root,
      contextTreePath: sharedClone,
      contextTreeRepoUrl: "https://github.com/acme/first-tree-context.git",
      contextTreeBranch: "main",
    });

    expect(refs).toEqual([
      {
        origin: "tool_arg",
        localPath: join(treeWorktree, "NODE.md"),
        repoUrl: "https://github.com/acme/first-tree-context.git",
        repoBranch: "main",
        repoRelativePath: "NODE.md",
        pathKind: "file",
      },
    ]);
  });
});
