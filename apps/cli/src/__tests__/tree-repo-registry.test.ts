import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ft-tree-repo-registry-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writePromptFile(name: "AGENTS.md" | "CLAUDE.md", text = "BEGIN CONTEXT-TREE FRAMEWORK\n"): string {
  const path = join(root, name);
  writeFileSync(path, text);
  return path;
}

describe("tree code repo registry", () => {
  it("creates managed blocks in existing prompt files with normalized, deduped GitHub repos", () => {
    writePromptFile("AGENTS.md");
    writePromptFile("CLAUDE.md", "# Project-Specific Instructions\n\nExisting notes\n");

    const action = syncTreeCodeRepoRegistry(root, [
      "git@github.com:acme/api.git",
      "https://github.com/acme/web.git",
      "https://gitlab.example/acme/ignored.git",
      "https://github.com/acme/api",
    ]);

    expect(action).toBe("updated");
    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain("BEGIN FIRST-TREE-CODE-REPO-REGISTRY");
    expect(agents).toContain("- [acme/api](https://github.com/acme/api)");
    expect(agents).toContain("- [acme/web](https://github.com/acme/web)");
    expect(agents).not.toContain("gitlab.example");

    const claude = readFileSync(join(root, "CLAUDE.md"), "utf8");
    expect(claude.indexOf("BEGIN FIRST-TREE-CODE-REPO-REGISTRY")).toBeLessThan(
      claude.indexOf("# Project-Specific Instructions"),
    );
    expect(listKnownTreeCodeRepos(root).map((repo) => repo.slug)).toEqual(["acme/api", "acme/web"]);
  });

  it("updates an existing managed block and reports unchanged on a second identical sync", () => {
    writePromptFile(
      "AGENTS.md",
      [
        "Intro",
        "<!-- BEGIN FIRST-TREE-CODE-REPO-REGISTRY -->",
        "old block",
        "<!--",
        "FIRST-TREE-CODE-REPO-REGISTRY: managed-block-v1",
        "FIRST-TREE-CODE-REPO: `https://github.com/acme/old`",
        "-->",
        "<!-- END FIRST-TREE-CODE-REPO-REGISTRY -->",
        "Tail",
        "",
      ].join("\n"),
    );

    expect(syncTreeCodeRepoRegistry(root, ["https://github.com/acme/new.git"])).toBe("updated");
    const current = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(current).toContain("- [acme/new](https://github.com/acme/new)");
    expect(current).not.toContain("acme/old");
    expect(current).toContain("Tail");
    expect(syncTreeCodeRepoRegistry(root, ["https://github.com/acme/new.git"])).toBe("unchanged");
  });

  it("falls back to tree bindings when prompt files do not have a managed block", () => {
    writePromptFile("AGENTS.md", "No managed registry here\n");
    mkdirSync(join(root, ".first-tree"), { recursive: true });
    writeTreeBinding(root, "web", {
      bindingMode: "workspace-member",
      entrypoint: "/workspaces/acme/repos/web",
      remoteUrl: "git@github.com:acme/web.git",
      rootKind: "git-repo",
      scope: "workspace",
      sourceId: "web",
      sourceName: "web",
      treeMode: "shared",
      treeRepoName: "context-tree",
      workspaceId: "acme",
    });
    writeTreeBinding(root, "invalid", {
      bindingMode: "workspace-member",
      entrypoint: "/workspaces/acme/repos/internal",
      remoteUrl: "https://gitlab.example/acme/internal.git",
      rootKind: "git-repo",
      scope: "workspace",
      sourceId: "internal",
      sourceName: "internal",
      treeMode: "shared",
      treeRepoName: "context-tree",
      workspaceId: "acme",
    });

    expect(listKnownTreeCodeRepos(root)).toEqual([
      { name: "web", slug: "acme/web", url: "https://github.com/acme/web" },
    ]);
  });

  it("upserts one repository while preserving known entries and skips invalid input or missing files", () => {
    writePromptFile("AGENTS.md");
    expect(syncTreeCodeRepoRegistry(root, ["https://github.com/acme/web.git"])).toBe("updated");

    expect(upsertTreeCodeRepoRegistry(root, "git@github.com:acme/api.git")).toBe("updated");
    expect(listKnownTreeCodeRepos(root).map((repo) => repo.slug)).toEqual(["acme/api", "acme/web"]);
    expect(upsertTreeCodeRepoRegistry(root, "not a github remote")).toBe("skipped");

    const missingRoot = mkdtempSync(join(tmpdir(), "ft-tree-repo-registry-missing-"));
    try {
      expect(syncTreeCodeRepoRegistry(missingRoot, ["https://github.com/acme/web.git"])).toBe("skipped");
      expect(existsSync(join(missingRoot, "AGENTS.md"))).toBe(false);
    } finally {
      rmSync(missingRoot, { recursive: true, force: true });
    }
  });

  it("builds the source repo index note", () => {
    expect(buildTreeCodeRepoIndexNote()).toContain("source-repos.md");
  });
});
