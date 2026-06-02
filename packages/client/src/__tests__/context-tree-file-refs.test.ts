import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toolFileRefsFromShellCommand } from "../runtime/context-tree-file-refs.js";

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
