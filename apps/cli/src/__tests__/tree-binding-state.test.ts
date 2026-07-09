import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BoundTreeReference,
  buildStableSourceId,
  buildTreeId,
  deriveDefaultEntrypoint,
  determineScope,
  isLegacyBindingMode,
  listTreeBindings,
  readSourceState,
  readTreeBinding,
  readTreeState,
  relativePathWithin,
  removeSourceState,
  type SourceState,
  sourceStatePath,
  type TreeBindingState,
  treeBindingPath,
  treeBindingsDir,
  treeStatePath,
  upsertWorkspaceMember,
  type WorkspaceMember,
  writeSourceState,
  writeTreeBinding,
  writeTreeState,
} from "../commands/tree/binding-state.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ft-tree-binding-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function tree(overrides: Partial<BoundTreeReference> = {}): BoundTreeReference {
  return {
    entrypoint: overrides.entrypoint ?? "/repos/app",
    remoteUrl: overrides.remoteUrl ?? "https://github.com/acme/context-tree.git",
    treeId: overrides.treeId ?? "context-tree",
    treeMode: overrides.treeMode ?? "shared",
    treeRepoName: overrides.treeRepoName ?? "context-tree",
  };
}

function sourceState(overrides: Partial<Omit<SourceState, "schemaVersion">> = {}): Omit<SourceState, "schemaVersion"> {
  return {
    bindingMode: overrides.bindingMode ?? "workspace-root",
    rootKind: overrides.rootKind ?? "git-repo",
    scope: overrides.scope ?? "workspace",
    sourceId: overrides.sourceId ?? "workspace-root",
    sourceName: overrides.sourceName ?? "First Tree Workspace",
    tree: overrides.tree ?? tree({ entrypoint: "/workspaces/first-tree" }),
    workspaceId: overrides.workspaceId ?? "first-tree",
    ...(overrides.members ? { members: overrides.members } : {}),
  };
}

function binding(
  overrides: Partial<Omit<TreeBindingState, "schemaVersion">> = {},
): Omit<TreeBindingState, "schemaVersion"> {
  return {
    bindingMode: overrides.bindingMode ?? "workspace-member",
    entrypoint: overrides.entrypoint ?? "/workspaces/first-tree/repos/api",
    remoteUrl: overrides.remoteUrl ?? "git@github.com:acme/api.git",
    rootKind: overrides.rootKind ?? "git-repo",
    scope: overrides.scope ?? "workspace",
    sourceId: overrides.sourceId ?? "api",
    sourceName: overrides.sourceName ?? "api",
    treeMode: overrides.treeMode ?? "shared",
    treeRepoName: overrides.treeRepoName ?? "context-tree",
    workspaceId: overrides.workspaceId ?? "first-tree",
  };
}

describe("tree binding state helpers", () => {
  it("round-trips source and tree state with schema defaults", () => {
    writeSourceState(root, sourceState());
    writeTreeState(root, {
      published: { remoteUrl: "git@github.com:acme/context-tree.git" },
      treeId: "context-tree",
      treeMode: "shared",
      treeRepoName: "context-tree",
    });

    mkdirSync(join(root, "custom-tree", ".first-tree"), { recursive: true });
    writeFileSync(
      treeStatePath(join(root, "custom-tree")),
      JSON.stringify({
        schemaVersion: 7,
        treeId: "custom-tree",
        treeMode: "dedicated",
        treeRepoName: "custom-tree",
      }),
    );
    mkdirSync(join(root, "folder-source", ".first-tree"), { recursive: true });
    writeFileSync(
      sourceStatePath(join(root, "folder-source")),
      JSON.stringify({
        bindingMode: "workspace-root",
        rootKind: "folder",
        scope: "workspace",
        schemaVersion: 3,
        sourceId: "folder-root",
        sourceName: "Folder Root",
        tree: {
          entrypoint: "/workspaces/folder-root",
          treeId: "folder-tree",
          treeMode: "shared",
          treeRepoName: "folder-tree",
        },
      }),
    );

    expect(readSourceState(root)).toMatchObject({
      bindingMode: "workspace-root",
      schemaVersion: 1,
      sourceId: "workspace-root",
      tree: { entrypoint: "/workspaces/first-tree" },
    });
    const folderSource = readSourceState(join(root, "folder-source"));
    expect(folderSource).toMatchObject({
      rootKind: "folder",
      schemaVersion: 3,
    });
    expect(folderSource?.tree).not.toHaveProperty("remoteUrl");
    expect(folderSource).not.toHaveProperty("workspaceId");
    expect(readTreeState(root)).toEqual({
      published: { remoteUrl: "git@github.com:acme/context-tree.git" },
      schemaVersion: 1,
      treeId: "context-tree",
      treeMode: "shared",
      treeRepoName: "context-tree",
    });
    expect(readTreeState(join(root, "custom-tree"))).toEqual({
      schemaVersion: 7,
      treeId: "custom-tree",
      treeMode: "dedicated",
      treeRepoName: "custom-tree",
    });
    expect(sourceStatePath(root)).toBe(join(root, ".first-tree", "source.json"));
    expect(treeStatePath(root)).toBe(join(root, ".first-tree", "tree.json"));
  });

  it("rejects malformed source, tree, and binding documents", () => {
    mkdirSync(treeBindingsDir(root), { recursive: true });
    writeFileSync(sourceStatePath(root), JSON.stringify({ bindingMode: "workspace-root", sourceId: "missing-tree" }));
    writeFileSync(treeStatePath(root), JSON.stringify({ treeId: "tree", treeMode: "invalid", treeRepoName: "tree" }));
    writeFileSync(treeBindingPath(root, "bad"), JSON.stringify({ sourceId: "bad", treeMode: "shared" }));

    expect(readSourceState(root)).toBeNull();
    expect(readTreeState(root)).toBeNull();
    expect(readTreeBinding(root, "bad")).toBeNull();

    writeFileSync(sourceStatePath(root), JSON.stringify({ ...sourceState(), tree: [] }));
    expect(readSourceState(root)).toBeNull();

    writeFileSync(sourceStatePath(root), JSON.stringify({ ...sourceState(), tree: { treeMode: "shared" } }));
    expect(readSourceState(root)).toBeNull();

    writeFileSync(sourceStatePath(root), JSON.stringify({ ...sourceState(), bindingMode: "future-mode" }));
    expect(readSourceState(root)).toBeNull();
  });

  it("round-trips and sorts tree bindings while ignoring invalid files", () => {
    writeTreeBinding(root, "zeta", binding({ sourceId: "zeta", sourceName: "zeta" }));
    writeTreeBinding(root, "alpha", binding({ sourceId: "alpha", sourceName: "alpha" }));
    writeFileSync(
      treeBindingPath(root, "folder"),
      JSON.stringify({
        bindingMode: "workspace-member",
        entrypoint: "/workspaces/first-tree/repos/folder",
        rootKind: "folder",
        schemaVersion: 4,
        scope: "workspace",
        sourceId: "folder",
        sourceName: "folder",
        treeMode: "shared",
        treeRepoName: "context-tree",
      }),
    );
    writeFileSync(join(treeBindingsDir(root), "ignored.txt"), "{}");
    writeFileSync(treeBindingPath(root, "broken"), JSON.stringify({ sourceId: "broken" }));

    expect(readTreeBinding(root, "alpha")).toMatchObject({
      sourceId: "alpha",
      schemaVersion: 1,
      remoteUrl: "git@github.com:acme/api.git",
    });
    const folderBinding = readTreeBinding(root, "folder");
    expect(folderBinding).toMatchObject({
      rootKind: "folder",
      schemaVersion: 4,
    });
    expect(folderBinding).not.toHaveProperty("remoteUrl");
    expect(folderBinding).not.toHaveProperty("workspaceId");
    expect(listTreeBindings(root).map((row) => row.sourceId)).toEqual(["alpha", "folder", "zeta"]);
  });

  it("returns null or empty values for missing state files", () => {
    expect(readSourceState(root)).toBeNull();
    expect(readTreeState(root)).toBeNull();
    expect(readTreeBinding(root, "missing")).toBeNull();
    expect(listTreeBindings(root)).toEqual([]);
  });

  it("builds stable identifiers and default entrypoints", () => {
    expect(buildStableSourceId("Ignored", { remoteUrl: "git@github.com:Acme/API.git" })).toBe("github-com-acme-api");
    expect(buildStableSourceId("Web App", { remoteUrl: "https://github.com/Acme/Web.git" })).toBe(
      "github-com-acme-web",
    );
    expect(buildStableSourceId("Private App", { remoteUrl: "ssh://git@example.com/acme/private.git" })).toBe(
      "example-com-acme-private",
    );

    expect(buildStableSourceId("Internal App", { remoteUrl: "ssh://git@gitlab.example/acme/internal.git" })).toBe(
      "gitlab-example-acme-internal",
    );

    const custom = buildStableSourceId("Internal App", { remoteUrl: "not a remote url" });
    expect(custom).toMatch(/^internal-app-[a-f0-9]{8}$/u);

    const folder = buildStableSourceId("", { fallbackRoot: join(root, "My Folder") });
    expect(folder).toMatch(/^my-folder-[a-f0-9]{8}$/u);
    expect(buildStableSourceId("Plain Source")).toMatch(/^plain-source-[a-f0-9]{8}$/u);
    expect(buildTreeId("Context Tree!")).toBe("context-tree");
    expect(determineScope("workspace-root")).toBe("workspace");
    expect(determineScope("workspace-member")).toBe("workspace");
    expect(determineScope("shared-source")).toBe("repo");
    expect(determineScope("standalone-source")).toBe("repo");
    expect(deriveDefaultEntrypoint("workspace-root", "Source Repo", "First Tree All")).toBe(
      "/workspaces/first-tree-all",
    );
    expect(deriveDefaultEntrypoint("workspace-root", "Source Repo")).toBe("/workspaces/source-repo");
    expect(deriveDefaultEntrypoint("workspace-member", "First Tree", "First Tree All")).toBe(
      "/workspaces/first-tree-all/repos/first-tree",
    );
    expect(deriveDefaultEntrypoint("workspace-member", "First Tree")).toBe("/workspaces/workspace/repos/first-tree");
    expect(deriveDefaultEntrypoint("shared-source", "First Tree")).toBe("/repos/first-tree");
    expect(deriveDefaultEntrypoint("standalone-source", "First Tree")).toBe("/");
    expect(relativePathWithin(root, join(root, "repos", "first-tree"))).toBe("repos/first-tree");
  });

  it("upserts workspace members without overwriting the root tree entrypoint", () => {
    const existingMember: WorkspaceMember = {
      bindingMode: "workspace-member",
      entrypoint: "/workspaces/first-tree/repos/alpha",
      rootKind: "git-repo",
      sourceId: "alpha",
      sourceName: "alpha",
    };
    writeSourceState(root, sourceState({ members: [existingMember] }));

    upsertWorkspaceMember(root, "first-tree", tree({ entrypoint: "/workspaces/first-tree/repos/api" }), {
      bindingMode: "workspace-member",
      entrypoint: "/workspaces/first-tree/repos/api",
      relativePath: "repos/api",
      remoteUrl: "https://github.com/acme/api.git",
      rootKind: "git-repo",
      sourceId: "api",
      sourceName: "api",
    });
    upsertWorkspaceMember(root, "first-tree", tree({ entrypoint: "/workspaces/first-tree/repos/api-v2" }), {
      bindingMode: "workspace-member",
      entrypoint: "/workspaces/first-tree/repos/api-v2",
      rootKind: "git-repo",
      sourceId: "api",
      sourceName: "api",
    });

    const current = readSourceState(root);
    expect(current?.tree.entrypoint).toBe("/workspaces/first-tree");
    expect(current?.members?.map((member) => [member.sourceName, member.entrypoint])).toEqual([
      ["alpha", "/workspaces/first-tree/repos/alpha"],
      ["api", "/workspaces/first-tree/repos/api-v2"],
    ]);

    writeSourceState(root, sourceState({ members: undefined }));
    upsertWorkspaceMember(root, "first-tree", tree({ entrypoint: "/workspaces/first-tree/repos/zeta" }), {
      bindingMode: "workspace-member",
      entrypoint: "/workspaces/first-tree/repos/zeta",
      rootKind: "git-repo",
      sourceId: "zeta",
      sourceName: "same",
    });
    upsertWorkspaceMember(root, "first-tree", tree({ entrypoint: "/workspaces/first-tree/repos/alpha" }), {
      bindingMode: "workspace-member",
      entrypoint: "/workspaces/first-tree/repos/alpha",
      rootKind: "git-repo",
      sourceId: "alpha",
      sourceName: "same",
    });
    expect(readSourceState(root)?.members?.map((member) => member.sourceId)).toEqual(["alpha", "zeta"]);
  });

  it("throws when upserting a member without workspace state and removes source state", () => {
    expect(() =>
      upsertWorkspaceMember(root, "first-tree", tree(), {
        bindingMode: "workspace-member",
        entrypoint: "/workspaces/first-tree/repos/api",
        rootKind: "git-repo",
        sourceId: "api",
        sourceName: "api",
      }),
    ).toThrow("Cannot upsert workspace member");

    writeSourceState(root, sourceState());
    expect(existsSync(sourceStatePath(root))).toBe(true);
    removeSourceState(root);
    expect(existsSync(sourceStatePath(root))).toBe(false);
  });

  it("filters invalid workspace members when reading source state", () => {
    mkdirSync(join(root, ".first-tree"), { recursive: true });
    writeFileSync(
      sourceStatePath(root),
      JSON.stringify({
        ...sourceState(),
        members: [
          null,
          { sourceId: "bad" },
          {
            bindingMode: "workspace-member",
            entrypoint: "/workspaces/first-tree/repos/web",
            relativePath: "repos/web",
            remoteUrl: "https://github.com/acme/web.git",
            rootKind: "git-repo",
            sourceId: "web",
            sourceName: "web",
          },
        ],
      }),
    );

    expect(readSourceState(root)?.members).toEqual([
      {
        bindingMode: "workspace-member",
        entrypoint: "/workspaces/first-tree/repos/web",
        relativePath: "repos/web",
        remoteUrl: "https://github.com/acme/web.git",
        rootKind: "git-repo",
        sourceId: "web",
        sourceName: "web",
      },
    ]);
  });

  it("writes deterministic JSON documents", () => {
    expect(isLegacyBindingMode("standalone-source")).toBe(true);
    expect(isLegacyBindingMode("shared-source")).toBe(true);
    expect(isLegacyBindingMode("workspace-root")).toBe(false);

    writeTreeBinding(root, "api", {
      bindingMode: "workspace-member",
      entrypoint: "/workspaces/first-tree/repos/api",
      rootKind: "git-repo",
      scope: "workspace",
      sourceId: "api",
      sourceName: "api",
      treeMode: "shared",
      treeRepoName: "context-tree",
      workspaceId: "first-tree",
    });
    const text = readFileSync(treeBindingPath(root, "api"), "utf8");

    expect(text).toContain('"schemaVersion": 1');
    expect(text.endsWith("\n")).toBe(true);
    expect(text).not.toContain("remoteUrl");
  });
});
