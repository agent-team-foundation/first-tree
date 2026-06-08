import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyPendingMigrations,
  MIGRATIONS_APPLIED_REL,
  MIGRATIONS_REGISTRY,
  type Migration,
} from "../runtime/workspace-migrations.js";

function initRepo(path: string, originUrl: string): void {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: path, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", originUrl], { cwd: path, stdio: "ignore" });
}

describe("workspace-migrations registry", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "workspace-migrations-test-"));
    mkdirSync(join(workspace, ".agent"), { recursive: true });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("v1-uuid-snapshots removes UUID-named directories that carry the legacy snapshot signature", () => {
    const uuidDir = join(workspace, "12345678-abcd-4def-89ab-1234567890ab");
    const namedDir = join(workspace, "first-tree");
    mkdirSync(uuidDir);
    // Legacy per-chat snapshots always had AGENTS.md / CLAUDE.md at their root.
    writeFileSync(join(uuidDir, "AGENTS.md"), "# legacy chat snapshot\n");
    mkdirSync(namedDir);

    applyPendingMigrations(workspace, () => {});

    expect(existsSync(uuidDir)).toBe(false);
    expect(existsSync(namedDir)).toBe(true);
  });

  it("v1-uuid-snapshots leaves UUID-named directories WITHOUT the legacy snapshot signature alone (PR #869 P0)", () => {
    // A user-created UUID-named directory (no AGENTS.md / CLAUDE.md at root)
    // must not be deleted — the migration is scoped to the per-chat-cwd shape.
    const userUuidDir = join(workspace, "abcdef01-2345-4789-abcd-ef0123456789");
    mkdirSync(userUuidDir);
    writeFileSync(join(userUuidDir, "user-data.json"), "{}");

    applyPendingMigrations(workspace, () => {});

    expect(existsSync(userUuidDir)).toBe(true);
    expect(existsSync(join(userUuidDir, "user-data.json"))).toBe(true);
  });

  it("v1-uuid-snapshots leaves a UUID-named directory that's currently in source_repos config (PR #869 P0)", () => {
    // Edge case: agent config has a `gitRepos.localPath` shaped like a UUID.
    // The migration must NOT delete it even when it has a top-level
    // AGENTS.md (e.g. the cloned repo happens to ship one).
    const uuidRepo = join(workspace, "fedcba98-7654-4321-9abc-def012345678");
    mkdirSync(uuidRepo);
    writeFileSync(join(uuidRepo, "AGENTS.md"), "# this repo happens to ship AGENTS.md\n");
    writeFileSync(
      join(workspace, ".agent", "managed.json"),
      JSON.stringify({
        schemaVersion: 1,
        cliVersion: "test",
        updatedAt: new Date().toISOString(),
        sourceRepos: ["fedcba98-7654-4321-9abc-def012345678"],
        skills: [],
      }),
    );

    applyPendingMigrations(workspace, () => {});

    expect(existsSync(uuidRepo)).toBe(true);
  });

  it("v1-uuid-snapshots leaves non-UUID names alone even if hexish", () => {
    const dirs = ["abc", "deadbeef", "0123456789abcdef0123456789abcdef"]; // wrong shape
    for (const d of dirs) {
      mkdirSync(join(workspace, d));
      // Add the snapshot signature too — proves the UUID shape is also required.
      writeFileSync(join(workspace, d, "AGENTS.md"), "");
    }

    applyPendingMigrations(workspace, () => {});

    for (const d of dirs) {
      expect(existsSync(join(workspace, d))).toBe(true);
    }
  });

  it("v1-retired-source-repo-first-tree-hub removes a `first-tree-hub/` with a broken `.git` pointer (PR #869 P0)", () => {
    // Reproduces the real-world shape code-reviewer flagged: `.git` is a
    // pointer file (not a directory), and its target gitdir has been
    // deleted, so `git config --get remote.origin.url` exits 128 and the
    // origin-URL-based `v1-orphan-ft-clones` sweep cannot match.
    const target = join(workspace, "first-tree-hub");
    mkdirSync(target);
    writeFileSync(join(target, ".git"), "gitdir: /tmp/does-not-exist/worktrees/first-tree-hub\n");

    applyPendingMigrations(workspace, () => {});

    expect(existsSync(target)).toBe(false);
  });

  it("v1-retired-source-repo-first-tree-hub does NOT remove `first-tree-hub/` if it's still in current source_repos", () => {
    const target = join(workspace, "first-tree-hub");
    mkdirSync(target);
    writeFileSync(join(target, ".git"), "gitdir: /tmp/somewhere\n");
    writeFileSync(
      join(workspace, ".agent", "managed.json"),
      JSON.stringify({
        schemaVersion: 1,
        cliVersion: "test",
        updatedAt: new Date().toISOString(),
        sourceRepos: ["first-tree-hub"],
        skills: [],
      }),
    );

    applyPendingMigrations(workspace, () => {});

    expect(existsSync(target)).toBe(true);
  });

  it("v1-retired-source-repo-first-tree-hub does NOT remove a plain directory named `first-tree-hub/` with no `.git`", () => {
    // A user could legitimately create a folder named first-tree-hub for
    // notes or scratch. Require the `.git` proof before deleting.
    const target = join(workspace, "first-tree-hub");
    mkdirSync(target);
    writeFileSync(join(target, "user-notes.md"), "# my notes\n");

    applyPendingMigrations(workspace, () => {});

    expect(existsSync(target)).toBe(true);
    expect(existsSync(join(target, "user-notes.md"))).toBe(true);
  });

  it("v1-retired-source-repo-first-tree-hub defers to v1-orphan-ft-clones when `.git` is a healthy directory (PR #869 code-reviewer follow-up)", () => {
    // A healthy clone — `.git` is a real directory. The retired-hub migration
    // must NOT bypass the dirty / ahead / worktree guards; v1-orphan-ft-clones
    // owns that path. Combined with the dirty payload below, this confirms
    // the safety guards still apply.
    const target = join(workspace, "first-tree-hub");
    initRepo(target, "https://github.com/agent-team-foundation/first-tree-hub");
    writeFileSync(join(target, "dirty.txt"), "uncommitted user work\n");

    applyPendingMigrations(workspace, () => {});

    expect(existsSync(target)).toBe(true);
    expect(existsSync(join(target, "dirty.txt"))).toBe(true);
  });

  it("v1-retired-source-repo-first-tree-hub does NOT delete when `.git` pointer target still exists (live linked checkout)", () => {
    // A `.git` pointer file whose target IS on disk is a live linked
    // checkout (`git worktree add`-style). Must not delete.
    const target = join(workspace, "first-tree-hub");
    mkdirSync(target);
    const livePointerTarget = join(workspace, "fake-gitdir");
    mkdirSync(livePointerTarget);
    writeFileSync(join(target, ".git"), `gitdir: ${livePointerTarget}\n`);

    applyPendingMigrations(workspace, () => {});

    expect(existsSync(target)).toBe(true);
    expect(existsSync(join(target, ".git"))).toBe(true);
  });

  it("does not touch <ws>/.first-tree/ (active W1 binding state — migration withdrawn)", () => {
    const dotFirstTree = join(workspace, ".first-tree");
    mkdirSync(dotFirstTree, { recursive: true });
    // The W1 binding manifest lives at `.first-tree/workspace.json` — see
    // `packages/shared/src/schemas/workspace-manifest.ts` (WORKSPACE_STATE_DIRNAME).
    // A blind sweep here would silently unbind the workspace on upgrade.
    writeFileSync(join(dotFirstTree, "workspace.json"), JSON.stringify({ tree: "tree", sources: [] }));

    applyPendingMigrations(workspace, () => {});

    expect(existsSync(dotFirstTree)).toBe(true);
    expect(existsSync(join(dotFirstTree, "workspace.json"))).toBe(true);
  });

  it("v1-whitepaper-symlink does NOT remove a regular WHITEPAPER.md file", () => {
    const whitepaper = join(workspace, "WHITEPAPER.md");
    writeFileSync(whitepaper, "# User's own document\n");

    applyPendingMigrations(workspace, () => {});

    expect(existsSync(whitepaper)).toBe(true);
    expect(readFileSync(whitepaper, "utf-8")).toBe("# User's own document\n");
  });

  it("v1-orphan-ft-clones holds back dirty clones via the shared safety guards", () => {
    const orphan = join(workspace, "first-tree-hub");
    initRepo(orphan, "https://github.com/agent-team-foundation/first-tree-hub");
    // Stage an unpushed dirty change so `git status --porcelain` reports
    // something — the safety guards should refuse to delete.
    writeFileSync(join(orphan, "dirty.txt"), "uncommitted work\n");

    writeFileSync(
      join(workspace, ".agent", "managed.json"),
      JSON.stringify({
        schemaVersion: 1,
        cliVersion: "test",
        updatedAt: new Date().toISOString(),
        sourceRepos: [],
        skills: [],
      }),
    );

    applyPendingMigrations(workspace, () => {});

    expect(existsSync(join(orphan, ".git"))).toBe(true);
    expect(existsSync(join(orphan, "dirty.txt"))).toBe(true);
  });

  it("v1-whitepaper-symlink removes WHITEPAPER.md at workspace root", () => {
    const whitepaper = join(workspace, "WHITEPAPER.md");
    // Symlink target need not resolve; the migration just unlinks.
    symlinkSync("/nonexistent", whitepaper);

    applyPendingMigrations(workspace, () => {});

    expect(existsSync(whitepaper)).toBe(false);
  });

  it("v1-orphan-ft-clones removes a clone whose origin is agent-team-foundation/* and not in current source repos", () => {
    initRepo(join(workspace, "first-tree-hub"), "https://github.com/agent-team-foundation/first-tree-hub");
    // The "current" set comes from `.agent/managed.json::sourceRepos`. An
    // empty file means everything FT-origin is orphan.
    writeFileSync(
      join(workspace, ".agent", "managed.json"),
      JSON.stringify({
        schemaVersion: 1,
        cliVersion: "test",
        updatedAt: new Date().toISOString(),
        sourceRepos: [],
        skills: [],
      }),
    );

    applyPendingMigrations(workspace, () => {});

    expect(existsSync(join(workspace, "first-tree-hub"))).toBe(false);
  });

  it("v1-orphan-ft-clones leaves a clone in current source_repos alone", () => {
    initRepo(join(workspace, "first-tree"), "https://github.com/agent-team-foundation/first-tree");
    writeFileSync(
      join(workspace, ".agent", "managed.json"),
      JSON.stringify({
        schemaVersion: 1,
        cliVersion: "test",
        updatedAt: new Date().toISOString(),
        sourceRepos: ["first-tree"],
        skills: [],
      }),
    );

    applyPendingMigrations(workspace, () => {});

    expect(existsSync(join(workspace, "first-tree", ".git"))).toBe(true);
  });

  it("v1-orphan-ft-clones leaves non-FT-origin clones alone", () => {
    initRepo(join(workspace, "user-side-clone"), "https://github.com/some-other-org/their-repo");

    applyPendingMigrations(workspace, () => {});

    expect(existsSync(join(workspace, "user-side-clone", ".git"))).toBe(true);
  });

  it("v1-orphan-ft-clones skips dotfile-prefixed entries and worktrees/notes", () => {
    initRepo(join(workspace, "worktrees"), "https://github.com/agent-team-foundation/anything");
    initRepo(join(workspace, "notes"), "https://github.com/agent-team-foundation/anything");
    initRepo(join(workspace, ".some-hidden"), "https://github.com/agent-team-foundation/anything");

    applyPendingMigrations(workspace, () => {});

    expect(existsSync(join(workspace, "worktrees", ".git"))).toBe(true);
    expect(existsSync(join(workspace, "notes", ".git"))).toBe(true);
    expect(existsSync(join(workspace, ".some-hidden", ".git"))).toBe(true);
  });
});

describe("applyPendingMigrations applier", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "workspace-migrations-applier-test-"));
    mkdirSync(join(workspace, ".agent"), { recursive: true });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("records applied ids in .agent/migrations-applied.json after a run", () => {
    const ran: string[] = [];
    const registry: readonly Migration[] = [
      { id: "test-alpha", description: "", apply: () => ran.push("alpha") },
      { id: "test-beta", description: "", apply: () => ran.push("beta") },
    ];

    const result = applyPendingMigrations(workspace, () => {}, registry);

    expect(result.applied).toEqual(["test-alpha", "test-beta"]);
    expect(ran).toEqual(["alpha", "beta"]);

    const markerPath = join(workspace, MIGRATIONS_APPLIED_REL);
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, "utf-8")) as { applied: string[] };
    expect(marker.applied).toEqual(["test-alpha", "test-beta"]);
  });

  it("skips migrations already listed in the marker", () => {
    writeFileSync(
      join(workspace, MIGRATIONS_APPLIED_REL),
      JSON.stringify({ schemaVersion: 1, applied: ["test-alpha"] }),
    );
    const ran: string[] = [];
    const registry: readonly Migration[] = [
      { id: "test-alpha", description: "", apply: () => ran.push("alpha") },
      { id: "test-beta", description: "", apply: () => ran.push("beta") },
    ];

    const result = applyPendingMigrations(workspace, () => {}, registry);

    expect(result.applied).toEqual(["test-beta"]);
    expect(result.skipped).toEqual(["test-alpha"]);
    expect(ran).toEqual(["beta"]);
  });

  it("does NOT record an id in the marker when its apply throws", () => {
    const registry: readonly Migration[] = [
      {
        id: "test-fails",
        description: "",
        apply: () => {
          throw new Error("synthetic failure");
        },
      },
      { id: "test-passes", description: "", apply: () => {} },
    ];

    const logs: string[] = [];
    const result = applyPendingMigrations(workspace, (msg) => logs.push(msg), registry);

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.id).toBe("test-fails");
    expect(result.applied).toEqual(["test-passes"]);

    const marker = JSON.parse(readFileSync(join(workspace, MIGRATIONS_APPLIED_REL), "utf-8")) as { applied: string[] };
    // test-fails MUST NOT appear in the marker so a future run retries.
    expect(marker.applied).toEqual(["test-passes"]);
    // The failure was surfaced via the log channel.
    expect(logs.some((l) => l.includes("test-fails"))).toBe(true);
  });

  it("does not rewrite the marker file when nothing new applied", () => {
    writeFileSync(
      join(workspace, MIGRATIONS_APPLIED_REL),
      JSON.stringify({ schemaVersion: 1, applied: ["test-alpha"] }),
    );
    const before = readFileSync(join(workspace, MIGRATIONS_APPLIED_REL), "utf-8");
    const registry: readonly Migration[] = [{ id: "test-alpha", description: "", apply: () => {} }];

    applyPendingMigrations(workspace, () => {}, registry);

    const after = readFileSync(join(workspace, MIGRATIONS_APPLIED_REL), "utf-8");
    expect(after).toBe(before);
  });

  it("treats a malformed marker as empty (re-applies all)", () => {
    writeFileSync(join(workspace, MIGRATIONS_APPLIED_REL), "{ not json");
    const ran: string[] = [];
    const registry: readonly Migration[] = [{ id: "test-alpha", description: "", apply: () => ran.push("alpha") }];

    const result = applyPendingMigrations(workspace, () => {}, registry);

    expect(result.applied).toEqual(["test-alpha"]);
    expect(ran).toEqual(["alpha"]);
  });

  it("MIGRATIONS_REGISTRY ids are unique (sanity check the production list)", () => {
    const ids = MIGRATIONS_REGISTRY.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("re-running on a clean workspace is a noop (registry idempotent)", () => {
    applyPendingMigrations(workspace, () => {});
    const markerBefore = readFileSync(join(workspace, MIGRATIONS_APPLIED_REL), "utf-8");
    applyPendingMigrations(workspace, () => {});
    const markerAfter = readFileSync(join(workspace, MIGRATIONS_APPLIED_REL), "utf-8");
    expect(markerAfter).toBe(markerBefore);
  });
});
