import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SOURCE_REPOS_DIRNAME } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONTEXT_TREE_DIRNAME, ensureWorkspaceManifest } from "../runtime/workspace-manifest.js";

describe("ensureWorkspaceManifest", () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "ft-ws-"));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  const manifestPath = () => join(ws, ".first-tree", "workspace.json");
  const treeDirPath = () => join(ws, CONTEXT_TREE_DIRNAME);

  it("writes .first-tree/workspace.json naming the tree dir + sources + sourcesRoot", () => {
    ensureWorkspaceManifest(ws, ["app", "api"]);
    expect(existsSync(manifestPath())).toBe(true);
    expect(JSON.parse(readFileSync(manifestPath(), "utf-8"))).toEqual({
      tree: CONTEXT_TREE_DIRNAME,
      sources: ["app", "api"],
      sourcesRoot: SOURCE_REPOS_DIRNAME,
    });
    // sourcesRoot pins the source clones one level down under source-repos/.
    expect(SOURCE_REPOS_DIRNAME).toBe("source-repos");
  });

  it("is idempotent across repeated calls", () => {
    ensureWorkspaceManifest(ws, ["app"]);
    expect(() => ensureWorkspaceManifest(ws, ["app"])).not.toThrow();
    expect(JSON.parse(readFileSync(manifestPath(), "utf-8"))).toEqual({
      tree: CONTEXT_TREE_DIRNAME,
      sources: ["app"],
      sourcesRoot: SOURCE_REPOS_DIRNAME,
    });
  });

  it("writes a valid manifest with no sources (tree-bound agent, no repos)", () => {
    ensureWorkspaceManifest(ws, []);
    expect(JSON.parse(readFileSync(manifestPath(), "utf-8"))).toEqual({
      tree: CONTEXT_TREE_DIRNAME,
      sources: [],
      sourcesRoot: SOURCE_REPOS_DIRNAME,
    });
  });

  it("drops a source with a nested localPath instead of dropping the whole manifest", () => {
    const logs: string[] = [];
    ensureWorkspaceManifest(ws, ["app", "nested/path", "api"], (msg) => logs.push(msg));
    // The valid sources still bind; the nested one is omitted (still on disk).
    expect(JSON.parse(readFileSync(manifestPath(), "utf-8"))).toEqual({
      tree: CONTEXT_TREE_DIRNAME,
      sources: ["app", "api"],
      sourcesRoot: SOURCE_REPOS_DIRNAME,
    });
    expect(logs.some((l) => l.includes('dropping source "nested/path"'))).toBe(true);
  });

  it("writes a source named context-tree (lives under source-repos/, no tree collision)", () => {
    // With sourcesRoot set, a source repo literally named `context-tree` lives
    // at `<ws>/source-repos/context-tree` — a different namespace from the tree
    // at `<ws>/context-tree` — so it is a valid source, NOT a reason to drop the
    // whole manifest and leave a tree-bound agent with no workspace.json.
    ensureWorkspaceManifest(ws, [CONTEXT_TREE_DIRNAME]);
    expect(JSON.parse(readFileSync(manifestPath(), "utf-8"))).toEqual({
      tree: CONTEXT_TREE_DIRNAME,
      sources: [CONTEXT_TREE_DIRNAME],
      sourcesRoot: SOURCE_REPOS_DIRNAME,
    });
  });

  it("creates no context-tree entry on disk — the agent materialises the clone itself", () => {
    ensureWorkspaceManifest(ws, ["app"]);
    expect(existsSync(manifestPath())).toBe(true);
    // The manifest may name a tree dir that does not exist yet; the runtime
    // must not create a directory or symlink (even a dangling one) at that path.
    expect(lstatSync(treeDirPath(), { throwIfNoEntry: false })).toBeUndefined();
  });

  it("logs and continues when the workspace state dir cannot be created", () => {
    const fileWorkspace = join(ws, "not-a-directory");
    const logs: string[] = [];
    writeFileSync(fileWorkspace, "already a file");

    expect(() => ensureWorkspaceManifest(fileWorkspace, ["app"], (msg) => logs.push(msg))).not.toThrow();

    expect(logs.some((line) => line.includes("workspace manifest write failed"))).toBe(true);
  });
});
