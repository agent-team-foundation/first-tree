import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("writes .first-tree/workspace.json naming the tree dir + sources", () => {
    ensureWorkspaceManifest(ws, ["app", "api"]);
    expect(existsSync(manifestPath())).toBe(true);
    expect(JSON.parse(readFileSync(manifestPath(), "utf-8"))).toEqual({
      tree: CONTEXT_TREE_DIRNAME,
      sources: ["app", "api"],
    });
  });

  it("is idempotent across repeated calls", () => {
    ensureWorkspaceManifest(ws, ["app"]);
    expect(() => ensureWorkspaceManifest(ws, ["app"])).not.toThrow();
    expect(JSON.parse(readFileSync(manifestPath(), "utf-8"))).toEqual({
      tree: CONTEXT_TREE_DIRNAME,
      sources: ["app"],
    });
  });

  it("writes a valid manifest with no sources (tree-bound agent, no repos)", () => {
    ensureWorkspaceManifest(ws, []);
    expect(JSON.parse(readFileSync(manifestPath(), "utf-8"))).toEqual({
      tree: CONTEXT_TREE_DIRNAME,
      sources: [],
    });
  });

  it("drops a source with a nested localPath instead of dropping the whole manifest", () => {
    const logs: string[] = [];
    ensureWorkspaceManifest(ws, ["app", "nested/path", "api"], (msg) => logs.push(msg));
    // The valid sources still bind; the nested one is omitted (still on disk).
    expect(JSON.parse(readFileSync(manifestPath(), "utf-8"))).toEqual({
      tree: CONTEXT_TREE_DIRNAME,
      sources: ["app", "api"],
    });
    expect(logs.some((l) => l.includes('dropping source "nested/path"'))).toBe(true);
  });

  it("skips the manifest entirely when a source repo is named context-tree", () => {
    ensureWorkspaceManifest(ws, [CONTEXT_TREE_DIRNAME]);
    // Refused to write a manifest that would put the tree name into `sources`.
    expect(existsSync(manifestPath())).toBe(false);
  });

  it("creates no context-tree entry on disk — the agent materialises the clone itself", () => {
    ensureWorkspaceManifest(ws, ["app"]);
    expect(existsSync(manifestPath())).toBe(true);
    // The manifest may name a tree dir that does not exist yet; the runtime
    // must not create a directory or symlink (even a dangling one) at that path.
    expect(lstatSync(treeDirPath(), { throwIfNoEntry: false })).toBeUndefined();
  });
});
