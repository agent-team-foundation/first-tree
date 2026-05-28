import { beforeEach, describe, expect, it, vi } from "vitest";

const buildSourceRepoIndexTableMock = vi.fn();
const existsSyncMock = vi.fn();
const listKnownTreeCodeReposMock = vi.fn();
const readFileSyncMock = vi.fn();
const readSourceBindingContractMock = vi.fn();
const readTreeIdentityContractMock = vi.fn();

async function loadBundleModule() {
  vi.doMock("node:fs", () => ({
    existsSync: existsSyncMock,
    readFileSync: readFileSyncMock,
  }));
  vi.doMock("../commands/tree/binding-contract.js", () => ({
    readSourceBindingContract: readSourceBindingContractMock,
  }));
  vi.doMock("../commands/tree/source-repo-index.js", () => ({
    buildSourceRepoIndexTable: buildSourceRepoIndexTableMock,
  }));
  vi.doMock("../commands/tree/tree-identity.js", () => ({
    readTreeIdentityContract: readTreeIdentityContractMock,
  }));
  vi.doMock("../commands/tree/tree-repo-registry.js", () => ({
    listKnownTreeCodeRepos: listKnownTreeCodeReposMock,
  }));

  return import("../commands/tree/tree-first-context.js");
}

describe("tree-first context bundle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue("Root NODE\n");
    buildSourceRepoIndexTableMock.mockReturnValue(["| Repo | Path |", "| first-tree | /source |"]);
    listKnownTreeCodeReposMock.mockReturnValue([{ name: "first-tree" }]);
    readSourceBindingContractMock.mockReturnValue(undefined);
    readTreeIdentityContractMock.mockReturnValue(undefined);
  });

  it("builds context from a tree repository root with repo index details", async () => {
    readTreeIdentityContractMock.mockImplementation((root: string) => (root === "/tree" ? { tree: true } : undefined));
    const { buildTreeFirstContextBundle } = await loadBundleModule();

    const bundle = buildTreeFirstContextBundle("/tree");

    expect(bundle?.treeRoot).toBe("/tree");
    expect(bundle?.additionalContext).toContain("Root NODE");
    expect(bundle?.additionalContext).toContain("Tree-First Cross-Repo Working Context");
    expect(bundle?.additionalContext).toContain("Current entrypoint: `tree repo root`");
    expect(bundle?.additionalContext).toContain("| first-tree | /source |");
  });

  it("resolves a bound source root through the temporary tree checkout", async () => {
    readSourceBindingContractMock.mockReturnValue({
      treeRepoName: "first-tree-context",
      entrypoint: "/workspace/source",
    });
    readTreeIdentityContractMock.mockImplementation((root: string) =>
      root === "/workspace/source/.first-tree/tmp/first-tree-context" ? { tree: true } : undefined,
    );
    listKnownTreeCodeReposMock.mockReturnValue([]);
    buildSourceRepoIndexTableMock.mockReturnValue([]);
    const { buildTreeFirstContextBundle } = await loadBundleModule();

    const bundle = buildTreeFirstContextBundle("/workspace/source");

    expect(bundle?.treeRoot).toBe("/workspace/source/.first-tree/tmp/first-tree-context");
    expect(bundle?.additionalContext).toContain("Current entrypoint: `/workspace/source`");
  });

  it("falls back to a local NODE.md when no tree binding is available", async () => {
    readFileSyncMock.mockReturnValue("Local NODE\n");
    const { buildTreeFirstContextBundle } = await loadBundleModule();

    expect(buildTreeFirstContextBundle("/source")).toEqual({
      additionalContext: "Local NODE\n",
      treeRoot: "/source",
    });
  });

  it("returns null when the resolved tree has no root NODE.md", async () => {
    readTreeIdentityContractMock.mockReturnValue({ tree: true });
    existsSyncMock.mockReturnValue(false);
    const { buildTreeFirstContextBundle } = await loadBundleModule();

    expect(buildTreeFirstContextBundle("/tree")).toBeNull();
  });
});
