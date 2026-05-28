import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BoundTreeReference,
  buildStableSourceId,
  buildTreeId,
  deriveDefaultEntrypoint,
  determineScope,
  listTreeBindings,
  readSourceState,
  readTreeBinding,
  readTreeState,
  relativePathWithin,
  removeSourceState,
  type SourceState,
  sourceStatePath,
  type TreeBindingState,
  type TreeState,
  treeBindingPath,
  treeStatePath,
  upsertWorkspaceMember,
  type WorkspaceMember,
  writeSourceState,
  writeTreeBinding,
  writeTreeState,
} from "../commands/tree/binding-state.js";

describe("tree binding state", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "first-tree-binding-state-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("round-trips source, tree, and per-source binding state with schema defaults", () => {
    const tree: BoundTreeReference = {
      entrypoint: "/workspaces/compute/repos/api",
      remoteUrl: "https://github.com/example/tree",
      treeId: "tree-id",
      treeMode: "shared",
      treeRepoName: "first-tree-context",
    };
    const source = {
      bindingMode: "workspace-member",
      rootKind: "git-repo",
      scope: "workspace",
      sourceId: "api-id",
      sourceName: "api",
      tree,
      workspaceId: "compute",
    } satisfies Omit<SourceState, "schemaVersion">;
    const treeState = {
      published: { remoteUrl: "git@github.com:example/tree.git" },
      treeId: "tree-id",
      treeMode: "shared",
      treeRepoName: "first-tree-context",
    } satisfies Omit<TreeState, "schemaVersion">;
    const binding = {
      bindingMode: "workspace-member",
      entrypoint: "/workspaces/compute/repos/api",
      remoteUrl: "https://github.com/example/api",
      rootKind: "git-repo",
      scope: "workspace",
      sourceId: "api-id",
      sourceName: "api",
      treeMode: "shared",
      treeRepoName: "first-tree-context",
      workspaceId: "compute",
    } satisfies Omit<TreeBindingState, "schemaVersion">;

    expect(sourceStatePath(tmp)).toBe(join(tmp, ".first-tree", "source.json"));
    expect(treeStatePath(tmp)).toBe(join(tmp, ".first-tree", "tree.json"));
    expect(treeBindingPath(tmp, "api-id")).toBe(join(tmp, ".first-tree", "bindings", "api-id.json"));

    writeSourceState(tmp, source);
    writeTreeState(tmp, treeState);
    writeTreeBinding(tmp, "api-id", binding);

    expect(readSourceState(tmp)).toEqual({ ...source, schemaVersion: 1 });
    expect(readTreeState(tmp)).toEqual({ ...treeState, schemaVersion: 1 });
    expect(readTreeBinding(tmp, "api-id")).toEqual({ ...binding, schemaVersion: 1 });

    removeSourceState(tmp);
    expect(readSourceState(tmp)).toBeNull();
  });

  it("rejects malformed state files and lists valid bindings in source-id order", () => {
    mkdirSync(join(tmp, ".first-tree", "bindings"), { recursive: true });
    writeFileSync(sourceStatePath(tmp), JSON.stringify({ bindingMode: "workspace-member" }));
    writeFileSync(treeStatePath(tmp), JSON.stringify({ treeMode: "shared" }));
    writeFileSync(treeBindingPath(tmp, "bad"), JSON.stringify({ sourceId: "bad" }));

    const baseBinding = {
      bindingMode: "shared-source",
      entrypoint: "/repos/source",
      rootKind: "folder",
      scope: "repo",
      sourceName: "source",
      treeMode: "dedicated",
      treeRepoName: "tree",
    } satisfies Omit<TreeBindingState, "schemaVersion" | "sourceId">;
    writeTreeBinding(tmp, "z-source", { ...baseBinding, sourceId: "z-source" });
    writeTreeBinding(tmp, "a-source", { ...baseBinding, sourceId: "a-source" });
    writeFileSync(join(tmp, ".first-tree", "bindings", "ignore.txt"), "{}");

    expect(readSourceState(tmp)).toBeNull();
    expect(readTreeState(tmp)).toBeNull();
    expect(readTreeBinding(tmp, "bad")).toBeNull();
    expect(listTreeBindings(tmp).map((entry) => entry.sourceId)).toEqual(["a-source", "z-source"]);
    expect(listTreeBindings(join(tmp, "missing"))).toEqual([]);
  });

  it("derives scopes, entrypoints, tree ids, relative paths, and stable source ids", () => {
    expect(determineScope("workspace-root")).toBe("workspace");
    expect(determineScope("workspace-member")).toBe("workspace");
    expect(determineScope("standalone-source")).toBe("repo");
    expect(determineScope("shared-source")).toBe("repo");

    expect(deriveDefaultEntrypoint("workspace-root", "My Workspace", "First Tree All")).toBe(
      "/workspaces/first-tree-all",
    );
    expect(deriveDefaultEntrypoint("workspace-member", "API Service", "First Tree All")).toBe(
      "/workspaces/first-tree-all/repos/api-service",
    );
    expect(deriveDefaultEntrypoint("shared-source", "API Service")).toBe("/repos/api-service");
    expect(deriveDefaultEntrypoint("standalone-source", "API Service")).toBe("/");

    expect(buildTreeId("First Tree Context")).toBe("first-tree-context");
    expect(
      buildStableSourceId("first-tree", { remoteUrl: "git@github.com:Agent-Team-Foundation/First-Tree.git" }),
    ).toBe("github-com-agent-team-foundation-first-tree");
    expect(buildStableSourceId("source", { remoteUrl: "ssh://git.example.local/team/source.git" })).toMatch(
      /^source-[0-9a-f]{8}$/,
    );
    expect(buildStableSourceId("", { fallbackRoot: join(tmp, "Repo Root") })).toMatch(/^repo-root-[0-9a-f]{8}$/);
    expect(relativePathWithin("/workspace/root", "/workspace/root/packages/api")).toBe("packages/api");
  });

  it("upserts workspace members while preserving the root tree entrypoint", () => {
    const rootTree: BoundTreeReference = {
      entrypoint: "/workspaces/compute",
      treeId: "tree-id",
      treeMode: "shared",
      treeRepoName: "tree",
    };
    writeSourceState(tmp, {
      bindingMode: "workspace-root",
      members: [
        {
          bindingMode: "workspace-member",
          entrypoint: "/workspaces/compute/repos/old",
          rootKind: "git-repo",
          sourceId: "old-id",
          sourceName: "old",
        },
      ],
      rootKind: "folder",
      scope: "workspace",
      sourceId: "root-id",
      sourceName: "compute",
      tree: rootTree,
      workspaceId: "compute",
    });

    const replacement: WorkspaceMember = {
      bindingMode: "workspace-member",
      entrypoint: "/workspaces/compute/repos/api",
      relativePath: "repos/api",
      remoteUrl: "https://github.com/example/api",
      rootKind: "git-repo",
      sourceId: "api-id",
      sourceName: "api",
    };
    const docs: WorkspaceMember = {
      bindingMode: "workspace-member",
      entrypoint: "/workspaces/compute/repos/docs",
      rootKind: "folder",
      sourceId: "docs-id",
      sourceName: "docs",
    };

    upsertWorkspaceMember(tmp, "compute", { ...rootTree, entrypoint: replacement.entrypoint }, replacement);
    upsertWorkspaceMember(tmp, "compute", { ...rootTree, entrypoint: docs.entrypoint }, docs);

    const state = readSourceState(tmp);
    expect(state?.tree.entrypoint).toBe("/workspaces/compute");
    expect(state?.members?.map((member) => member.sourceId)).toEqual(["api-id", "docs-id", "old-id"]);
    expect(state?.members?.[0]).toEqual(replacement);
  });

  it("throws when upserting a workspace member without a valid workspace root state", () => {
    expect(() =>
      upsertWorkspaceMember(
        tmp,
        "compute",
        { entrypoint: "/workspaces/compute/repos/api", treeId: "tree", treeMode: "shared", treeRepoName: "tree" },
        {
          bindingMode: "workspace-member",
          entrypoint: "/workspaces/compute/repos/api",
          rootKind: "git-repo",
          sourceId: "api-id",
          sourceName: "api",
        },
      ),
    ).toThrow("Cannot upsert workspace member");

    expect(readSourceState(tmp)).toBeNull();
  });
});
