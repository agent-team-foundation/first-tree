import { describe, expect, it } from "vitest";
import { SOURCE_REPOS_DIRNAME, workspaceManifestSchema } from "../schemas/workspace-manifest.js";

describe("workspaceManifestSchema", () => {
  it("accepts a manifest with sourcesRoot (the agent-managed layout)", () => {
    const parsed = workspaceManifestSchema.parse({
      tree: "context-tree",
      sources: ["api", "web"],
      sourcesRoot: SOURCE_REPOS_DIRNAME,
    });
    expect(parsed.sourcesRoot).toBe("source-repos");
    expect(parsed.sources).toEqual(["api", "web"]);
  });

  it("accepts a manifest without sourcesRoot (legacy flat layout — optional field)", () => {
    const parsed = workspaceManifestSchema.parse({ tree: "context-tree", sources: ["api"] });
    expect(parsed.sourcesRoot).toBeUndefined();
  });

  it("rejects a sourcesRoot equal to the tree subdirectory", () => {
    const result = workspaceManifestSchema.safeParse({
      tree: "context-tree",
      sources: ["api"],
      sourcesRoot: "context-tree",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a sourcesRoot that is not a single subdirectory name", () => {
    expect(workspaceManifestSchema.safeParse({ tree: "t", sources: [], sourcesRoot: "a/b" }).success).toBe(false);
    expect(workspaceManifestSchema.safeParse({ tree: "t", sources: [], sourcesRoot: ".." }).success).toBe(false);
    expect(workspaceManifestSchema.safeParse({ tree: "t", sources: [], sourcesRoot: ".hidden" }).success).toBe(false);
  });

  it("still rejects the tree appearing in sources regardless of sourcesRoot", () => {
    const result = workspaceManifestSchema.safeParse({
      tree: "context-tree",
      sources: ["context-tree"],
      sourcesRoot: SOURCE_REPOS_DIRNAME,
    });
    expect(result.success).toBe(false);
  });

  it("SOURCE_REPOS_DIRNAME is the reserved source-repos directory name", () => {
    expect(SOURCE_REPOS_DIRNAME).toBe("source-repos");
  });
});
