import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeTreeBinding } from "../commands/tree/binding-state.js";
import {
  buildTreeCodeRepoIndexNote,
  listKnownTreeCodeRepos,
  syncTreeCodeRepoRegistry,
  upsertTreeCodeRepoRegistry,
} from "../commands/tree/tree-repo-registry.js";

describe("tree code repo registry", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "first-tree-registry-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates sorted managed registry blocks in existing agent instruction files", () => {
    writeFileSync(join(tmp, "AGENTS.md"), "# Tree\n\n# Project-Specific Instructions\n\nKeep this section.\n");
    writeFileSync(join(tmp, "CLAUDE.md"), "# Tree\n\n<!-- END CONTEXT-TREE FRAMEWORK -->\n\nTail.\n");

    const action = syncTreeCodeRepoRegistry(tmp, [
      "git@github.com:example/zeta.git",
      "https://github.com/example/alpha",
      "https://gitlab.example.com/example/ignored",
      "https://github.com/example/alpha.git",
    ]);

    expect(action).toBe("updated");
    expect(readFileSync(join(tmp, "AGENTS.md"), "utf-8")).toContain(
      ["<!-- BEGIN FIRST-TREE-CODE-REPO-REGISTRY -->", "## Managed Code Repos", "", "> Managed block"].join("\n"),
    );
    expect(readFileSync(join(tmp, "AGENTS.md"), "utf-8")).toContain(
      "- [example/alpha](https://github.com/example/alpha)\n- [example/zeta](https://github.com/example/zeta)",
    );
    expect(readFileSync(join(tmp, "AGENTS.md"), "utf-8")).toContain("# Project-Specific Instructions");
    expect(readFileSync(join(tmp, "CLAUDE.md"), "utf-8")).toContain("<!-- END CONTEXT-TREE FRAMEWORK -->");
    expect(listKnownTreeCodeRepos(tmp).map((repo) => repo.slug)).toEqual(["example/alpha", "example/zeta"]);
  });

  it("updates existing managed blocks and reports unchanged when content is stable", () => {
    const initial = [
      "# Tree",
      "",
      "<!-- BEGIN FIRST-TREE-CODE-REPO-REGISTRY -->",
      "old block",
      "<!--",
      "FIRST-TREE-CODE-REPO-REGISTRY: managed-block-v1",
      "FIRST-TREE-CODE-REPO: `https://github.com/example/old`",
      "-->",
      "<!-- END FIRST-TREE-CODE-REPO-REGISTRY -->",
      "",
      "Tail.",
    ].join("\n");
    writeFileSync(join(tmp, "AGENTS.md"), initial);

    expect(upsertTreeCodeRepoRegistry(tmp, "https://github.com/example/new.git")).toBe("updated");
    const updated = readFileSync(join(tmp, "AGENTS.md"), "utf-8");

    expect(updated).toContain("- [example/new](https://github.com/example/new)");
    expect(updated).toContain("- [example/old](https://github.com/example/old)");
    expect(updated).toContain("Tail.\n");
    expect(syncTreeCodeRepoRegistry(tmp, ["https://github.com/example/new", "https://github.com/example/old"])).toBe(
      "unchanged",
    );
  });

  it("falls back to tree bindings and skips invalid or absent registry targets", () => {
    expect(syncTreeCodeRepoRegistry(tmp, ["https://github.com/example/no-files"])).toBe("skipped");
    expect(upsertTreeCodeRepoRegistry(tmp, "https://gitlab.example.com/example/nope")).toBe("skipped");

    mkdirSync(join(tmp, ".first-tree", "bindings"), { recursive: true });
    writeTreeBinding(tmp, "api", {
      bindingMode: "shared-source",
      entrypoint: "/repos/api",
      remoteUrl: "git@github.com:example/api.git",
      rootKind: "git-repo",
      scope: "repo",
      sourceId: "api",
      sourceName: "api",
      treeMode: "shared",
      treeRepoName: "tree",
    });
    writeTreeBinding(tmp, "invalid", {
      bindingMode: "shared-source",
      entrypoint: "/repos/invalid",
      remoteUrl: "https://example.com/not/github",
      rootKind: "git-repo",
      scope: "repo",
      sourceId: "invalid",
      sourceName: "invalid",
      treeMode: "shared",
      treeRepoName: "tree",
    });

    expect(listKnownTreeCodeRepos(tmp)).toEqual([
      {
        name: "api",
        slug: "example/api",
        url: "https://github.com/example/api",
      },
    ]);
    expect(buildTreeCodeRepoIndexNote()).toContain("source-repos.md");
  });
});
