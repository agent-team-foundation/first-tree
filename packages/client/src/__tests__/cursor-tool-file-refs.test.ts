import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolFileRef } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enrichCursorToolFileRefs } from "../handlers/cursor/sdk.js";

/**
 * Finding 6: the pure cursor parser emits `localPath`-only file refs; the server
 * Context Tree I/O normalizer counts a ref ONLY when it carries `repoUrl` +
 * `repoRelativePath` matching the org binding. The handler must therefore
 * resolve the local path against the bound tree — mirroring codex's ref
 * enrichment — or cursor edit/write/read events are recognized by tool NAME but
 * never actually counted.
 */

const TREE_REPO = "https://github.com/acme/first-tree-context.git";
let treeRoot: string;
let outsideRoot: string;

beforeEach(() => {
  treeRoot = mkdtempSync(join(tmpdir(), "ft-cursor-tree-"));
  outsideRoot = mkdtempSync(join(tmpdir(), "ft-cursor-outside-"));
});

afterEach(() => {
  rmSync(treeRoot, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
});

function ref(localPath: string, origin: ToolFileRef["origin"]): ToolFileRef {
  return { localPath, pathKind: "file", origin };
}

type Binding = Parameters<typeof enrichCursorToolFileRefs>[1];

function enrichOne(input: ToolFileRef, binding: Binding): ToolFileRef {
  const [out] = enrichCursorToolFileRefs([input], binding);
  if (!out) throw new Error("expected exactly one enriched ref");
  return out;
}

describe("enrichCursorToolFileRefs", () => {
  it("resolves a localPath inside the bound Context Tree to repo coordinates", () => {
    mkdirSync(join(treeRoot, "members", "alice"), { recursive: true });
    const filePath = join(treeRoot, "members", "alice", "NODE.md");
    writeFileSync(filePath, "x", "utf-8");

    const out = enrichOne(ref(filePath, "file_change"), {
      cwd: treeRoot,
      contextTreePath: treeRoot,
      contextTreeRepoUrl: TREE_REPO,
      contextTreeBranch: "main",
    });
    expect(out).toMatchObject({
      localPath: filePath,
      origin: "file_change",
      pathKind: "file",
      repoUrl: TREE_REPO,
      repoBranch: "main",
      repoRelativePath: "members/alice/NODE.md",
    });
  });

  it("leaves a localPath OUTSIDE the tree unresolved, so the server correctly skips it", () => {
    const filePath = join(outsideRoot, "secret.md");
    writeFileSync(filePath, "x", "utf-8");

    const out = enrichOne(ref(filePath, "tool_arg"), {
      cwd: treeRoot,
      contextTreePath: treeRoot,
      contextTreeRepoUrl: TREE_REPO,
      contextTreeBranch: "main",
    });
    expect(out.repoUrl).toBeUndefined();
    expect(out.repoRelativePath).toBeUndefined();
  });

  it("no-ops when there is no bound Context Tree repo url", () => {
    const filePath = join(treeRoot, "x.md");
    writeFileSync(filePath, "x", "utf-8");

    const out = enrichOne(ref(filePath, "file_change"), {
      cwd: treeRoot,
      contextTreePath: treeRoot,
      contextTreeRepoUrl: null,
      contextTreeBranch: null,
    });
    expect(out.repoUrl).toBeUndefined();
    expect(out.repoRelativePath).toBeUndefined();
  });

  it("preserves an already-resolved ref and omits repoBranch when unset", () => {
    mkdirSync(join(treeRoot, "d"), { recursive: true });
    const filePath = join(treeRoot, "d", "f.md");
    writeFileSync(filePath, "x", "utf-8");

    const out = enrichOne(ref(filePath, "file_change"), {
      cwd: treeRoot,
      contextTreePath: treeRoot,
      contextTreeRepoUrl: TREE_REPO,
      contextTreeBranch: null,
    });
    expect(out.repoUrl).toBe(TREE_REPO);
    expect(out.repoRelativePath).toBe("d/f.md");
    expect(out.repoBranch).toBeUndefined();
  });
});
