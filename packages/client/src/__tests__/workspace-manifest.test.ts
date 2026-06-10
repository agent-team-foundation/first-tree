import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONTEXT_TREE_LINK_DIRNAME, ensureWorkspaceManifest } from "../runtime/workspace-manifest.js";

describe("ensureWorkspaceManifest", () => {
  let ws: string;
  let tree: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "ft-ws-"));
    tree = mkdtempSync(join(tmpdir(), "ft-tree-"));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
    rmSync(tree, { recursive: true, force: true });
  });

  const manifestPath = () => join(ws, ".first-tree", "workspace.json");
  const linkPath = () => join(ws, CONTEXT_TREE_LINK_DIRNAME);

  it("writes .first-tree/workspace.json naming the tree link + sources", () => {
    ensureWorkspaceManifest(ws, tree, ["app", "api"]);
    expect(existsSync(manifestPath())).toBe(true);
    expect(JSON.parse(readFileSync(manifestPath(), "utf-8"))).toEqual({
      tree: CONTEXT_TREE_LINK_DIRNAME,
      sources: ["app", "api"],
    });
  });

  it("exposes the external tree clone as a sibling symlink", () => {
    ensureWorkspaceManifest(ws, tree, ["app"]);
    expect(lstatSync(linkPath()).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath())).toBe(tree);
  });

  it("is idempotent across repeated calls", () => {
    ensureWorkspaceManifest(ws, tree, ["app"]);
    expect(() => ensureWorkspaceManifest(ws, tree, ["app"])).not.toThrow();
    expect(readlinkSync(linkPath())).toBe(tree);
    expect(JSON.parse(readFileSync(manifestPath(), "utf-8")).tree).toBe(CONTEXT_TREE_LINK_DIRNAME);
  });

  it("repoints the symlink when the tree clone path changes (rebind)", () => {
    ensureWorkspaceManifest(ws, tree, ["app"]);
    const tree2 = mkdtempSync(join(tmpdir(), "ft-tree2-"));
    try {
      ensureWorkspaceManifest(ws, tree2, ["app"]);
      expect(readlinkSync(linkPath())).toBe(tree2);
    } finally {
      rmSync(tree2, { recursive: true, force: true });
    }
  });

  it("never clobbers a real source dir colliding with the link name, and writes no manifest", () => {
    // A source repo literally named `context-tree` is already checked out.
    mkdirSync(linkPath());
    writeFileSync(join(linkPath(), "code.ts"), "x", "utf-8");
    ensureWorkspaceManifest(ws, tree, [CONTEXT_TREE_LINK_DIRNAME]);
    expect(lstatSync(linkPath()).isDirectory()).toBe(true);
    expect(existsSync(join(linkPath(), "code.ts"))).toBe(true);
    // Refused to write a manifest that would put the tree name into `sources`.
    expect(existsSync(manifestPath())).toBe(false);
  });

  it("writes a valid manifest with no sources (tree-bound agent, no repos)", () => {
    ensureWorkspaceManifest(ws, tree, []);
    expect(JSON.parse(readFileSync(manifestPath(), "utf-8"))).toEqual({
      tree: CONTEXT_TREE_LINK_DIRNAME,
      sources: [],
    });
  });

  it("drops a source with a nested localPath instead of dropping the whole manifest", () => {
    ensureWorkspaceManifest(ws, tree, ["app", "nested/path", "api"]);
    // The valid sources still bind; the nested one is omitted (still on disk).
    expect(JSON.parse(readFileSync(manifestPath(), "utf-8"))).toEqual({
      tree: CONTEXT_TREE_LINK_DIRNAME,
      sources: ["app", "api"],
    });
    expect(lstatSync(linkPath()).isSymbolicLink()).toBe(true);
  });

  it("refuses to write a manifest when a real (non-symlink) dir occupies the link path", () => {
    // A leftover real dir at the link path (not a declared source).
    mkdirSync(linkPath());
    ensureWorkspaceManifest(ws, tree, ["app"]);
    expect(lstatSync(linkPath()).isDirectory()).toBe(true); // not clobbered
    expect(existsSync(manifestPath())).toBe(false); // tree not linked → no manifest
  });
});
