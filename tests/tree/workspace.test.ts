import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeSourceRepo, useTmpDir } from "../helpers.js";

const mockState = vi.hoisted(() => ({
  root: null as string | null,
  entries: null as import("node:fs").Dirent[] | null,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();

  return {
    ...actual,
    readdirSync: ((path: unknown, options?: unknown) => {
      if (
        path === mockState.root &&
        typeof options === "object" &&
        options !== null &&
        "withFileTypes" in options &&
        options.withFileTypes === true &&
        mockState.entries !== null
      ) {
        return mockState.entries;
      }
      return actual.readdirSync(
        path as Parameters<typeof actual.readdirSync>[0],
        options as never,
      );
    }) as typeof actual.readdirSync,
  };
});

describe("discoverWorkspaceRepos", () => {
  afterEach(() => {
    mockState.root = null;
    mockState.entries = null;
    vi.resetModules();
  });

  it("falls back to lstat when dirent type is unknown", async () => {
    const tmp = useTmpDir();
    makeSourceRepo(tmp.path);
    const nestedRoot = join(tmp.path, "nested");
    makeSourceRepo(nestedRoot);

    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const realReaddirSync = actualFs.readdirSync.bind(actualFs);
    const rootEntries = realReaddirSync(tmp.path, { withFileTypes: true });

    mockState.root = tmp.path;
    mockState.entries = rootEntries.map((entry) =>
      entry.name === "nested"
        ? ({
            name: entry.name,
            isBlockDevice: () => false,
            isCharacterDevice: () => false,
            isDirectory: () => false,
            isFIFO: () => false,
            isFile: () => false,
            isSocket: () => false,
            isSymbolicLink: () => false,
          } as import("node:fs").Dirent)
        : entry
    );
    vi.resetModules();

    const { discoverWorkspaceRepos } = await import(
      "#products/tree/engine/workspace.js"
    );

    expect(discoverWorkspaceRepos(tmp.path)).toEqual([
      {
        kind: "nested-git-repo",
        name: "nested",
        relativePath: "nested",
        root: nestedRoot,
      },
    ]);
  });
});
