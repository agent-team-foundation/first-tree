import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeAgentsMd, makeGitRepo, makeTreeMetadata, useTmpDir } from "./helpers.js";
import { syncTreeSourceRepoIndex } from "#products/tree/engine/runtime/source-repo-index.js";
import { writeTreeBinding } from "#products/tree/engine/runtime/binding-state.js";

describe("syncTreeSourceRepoIndex", () => {
  it("writes the repo index and updates root guidance from bindings", () => {
    const treeDir = useTmpDir();
    makeGitRepo(treeDir.path);
    makeTreeMetadata(treeDir.path, "0.1.0");
    makeAgentsMd(treeDir.path, { markers: true, userContent: true });
    writeFileSync(
      join(treeDir.path, "NODE.md"),
      [
        "---",
        "title: Example Tree",
        "owners: [alice]",
        "---",
        "",
        "# Example Tree",
        "",
        "Context for the organization.",
        "",
        "## Domains",
        "",
        "- **[members/](members/NODE.md)** — Members.",
        "",
      ].join("\n"),
    );

    writeTreeBinding(treeDir.path, "alpha-11111111", {
      bindingMode: "shared-source",
      entrypoint: "/repos/alpha",
      remoteUrl: "git@github.com:acme/alpha.git",
      rootKind: "git-repo",
      scope: "repo",
      sourceId: "alpha-11111111",
      sourceName: "alpha",
      sourceRootPath: "../alpha",
      treeMode: "shared",
      treeRepoName: "org-context",
    });
    writeTreeBinding(treeDir.path, "workspace-22222222", {
      bindingMode: "workspace-root",
      entrypoint: "/workspaces/platform",
      remoteUrl: "https://github.com/acme/platform-workspace.git",
      rootKind: "git-repo",
      scope: "workspace",
      sourceId: "workspace-22222222",
      sourceName: "platform-workspace",
      sourceRootPath: "../platform-workspace",
      treeMode: "shared",
      treeRepoName: "org-context",
      workspaceId: "platform",
    });
    writeTreeBinding(treeDir.path, "beta-33333333", {
      bindingMode: "workspace-member",
      entrypoint: "/workspaces/platform/repos/beta",
      rootKind: "git-repo",
      scope: "workspace",
      sourceId: "beta-33333333",
      sourceName: "beta",
      sourceRootPath: "../beta",
      treeMode: "shared",
      treeRepoName: "org-context",
      workspaceId: "platform",
      workspaceRootPath: "..",
    });

    const result = syncTreeSourceRepoIndex(treeDir.path);
    const sourceRepos = readFileSync(join(treeDir.path, "source-repos.md"), "utf-8");
    const node = readFileSync(join(treeDir.path, "NODE.md"), "utf-8");
    const agents = readFileSync(join(treeDir.path, "AGENTS.md"), "utf-8");

    expect(result.indexAction).toBe("created");
    expect(sourceRepos).toContain('title: "Source Repos"');
    expect(sourceRepos).toContain("owners: []");
    expect(sourceRepos).toContain("[acme/alpha](https://github.com/acme/alpha)");
    expect(sourceRepos).toContain(
      "[acme/platform-workspace](https://github.com/acme/platform-workspace)",
    );
    expect(sourceRepos).toContain("Missing in binding metadata");
    expect(node).toContain("## Source Repos");
    expect(node).toContain("[Source Repos](source-repos.md)");
    expect(agents).toContain("## Source Repo Index");
    expect(agents).toContain(".first-tree/bindings/");

    const second = syncTreeSourceRepoIndex(treeDir.path);
    expect(second.indexAction).toBe("unchanged");
    expect(second.rootNodeAction).toBe("unchanged");
    expect(second.agentsAction).toBe("unchanged");
  });
});
