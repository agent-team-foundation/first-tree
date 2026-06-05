import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TREE_CODE_REPOS_FILE, writeTreeBinding } from "../commands/tree/binding-state.js";
import {
  buildSourceRepoIndexTable,
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

  it("upserts one repository while preserving known entries and skips invalid input", () => {
    writePromptFile("AGENTS.md");
    expect(syncTreeCodeRepoRegistry(root, ["https://github.com/acme/web.git"])).toBe("updated");

    expect(upsertTreeCodeRepoRegistry(root, "git@github.com:acme/api.git")).toBe("updated");
    expect(listKnownTreeCodeRepos(root).map((repo) => repo.slug)).toEqual(["acme/api", "acme/web"]);
    expect(upsertTreeCodeRepoRegistry(root, "not a github remote")).toBe("skipped");
  });

  // Regression — issue surfaced on PR #794 (yuezengwu + baixiaohang Finding 2).
  // Before the fix, `syncTreeCodeRepoRegistry` only wrote into tree-root
  // `AGENTS.md` / `CLAUDE.md` and returned "skipped" when neither existed.
  // Since PR #794 deletes those files from new trees, a fresh `tree init` with
  // a GitHub origin used to produce an empty `source-repos.md`.
  it("persists registry to `.first-tree/code-repos.json` for new trees that no longer carry AGENTS.md / CLAUDE.md", () => {
    expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(root, "CLAUDE.md"))).toBe(false);

    const action = syncTreeCodeRepoRegistry(root, ["https://github.com/acme/web.git", "git@github.com:acme/api.git"]);

    expect(action).toBe("created");
    const persistedPath = join(root, TREE_CODE_REPOS_FILE);
    expect(existsSync(persistedPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(persistedPath, "utf8")) as {
      repos: Array<{ slug: string; url: string }>;
      schemaVersion: number;
    };
    expect(persisted.schemaVersion).toBe(1);
    expect(persisted.repos.map((r) => r.slug)).toEqual(["acme/api", "acme/web"]);
    expect(listKnownTreeCodeRepos(root).map((repo) => repo.slug)).toEqual(["acme/api", "acme/web"]);

    // Tree-root prompt files are not created as a side effect of registering.
    expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(root, "CLAUDE.md"))).toBe(false);
  });

  it("re-syncing the same registry to a new tree is idempotent", () => {
    expect(syncTreeCodeRepoRegistry(root, ["https://github.com/acme/web.git"])).toBe("created");
    expect(syncTreeCodeRepoRegistry(root, ["https://github.com/acme/web.git"])).toBe("unchanged");
  });

  it("`listKnownTreeCodeRepos` prefers `.first-tree/code-repos.json` over legacy AGENTS.md / CLAUDE.md", () => {
    // Legacy registry says "old"; new JSON store says "new". Read path must
    // prefer the JSON.
    writePromptFile(
      "AGENTS.md",
      [
        "<!-- BEGIN FIRST-TREE-CODE-REPO-REGISTRY -->",
        "<!--",
        "FIRST-TREE-CODE-REPO-REGISTRY: managed-block-v1",
        "FIRST-TREE-CODE-REPO: `https://github.com/acme/legacy`",
        "-->",
        "<!-- END FIRST-TREE-CODE-REPO-REGISTRY -->",
        "",
      ].join("\n"),
    );
    syncTreeCodeRepoRegistry(root, ["https://github.com/acme/new.git"]);

    expect(listKnownTreeCodeRepos(root).map((repo) => repo.slug)).toEqual(["acme/new"]);
  });

  it("`syncTreeCodeRepoRegistry` mirrors writes into legacy AGENTS.md / CLAUDE.md when they exist", () => {
    // Migration safety: a tree predating PR #794 still has the prompt files;
    // the registry should keep them in sync alongside the canonical JSON
    // store so contributors still reading those files see the same data.
    writePromptFile("AGENTS.md");

    syncTreeCodeRepoRegistry(root, ["https://github.com/acme/web.git"]);

    const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain("FIRST-TREE-CODE-REPO: `https://github.com/acme/web`");

    const persisted = JSON.parse(readFileSync(join(root, TREE_CODE_REPOS_FILE), "utf8")) as {
      repos: Array<{ slug: string }>;
    };
    expect(persisted.repos.map((r) => r.slug)).toEqual(["acme/web"]);
  });

  it("builds the agent-context `## Managed Code Repos` markdown table", () => {
    expect(buildSourceRepoIndexTable([])).toEqual(["No managed code repos have been recorded yet."]);

    const lines = buildSourceRepoIndexTable([
      { name: "web", slug: "acme/web", url: "https://github.com/acme/web.git" },
      { name: "api", slug: "acme/api", url: "https://gitlab.example.com/acme/api.git" },
    ]);

    // Header
    expect(lines[0]).toBe("| Source | GitHub |");
    expect(lines[1]).toBe("| --- | --- |");

    // GitHub URL renders as a markdown link
    expect(lines[2]).toContain("`web`");
    expect(lines[2]).toContain("[acme/web](https://github.com/acme/web)");

    // Non-GitHub URL falls back to a code span of the raw URL
    expect(lines[3]).toContain("`api`");
    expect(lines[3]).toContain("`https://gitlab.example.com/acme/api.git`");
  });
});
