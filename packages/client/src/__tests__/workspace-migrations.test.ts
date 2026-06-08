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

  it("v1-uuid-snapshots removes UUID-named directories at workspace root", () => {
    const uuidDir = join(workspace, "12345678-abcd-4def-89ab-1234567890ab");
    const namedDir = join(workspace, "first-tree");
    mkdirSync(uuidDir);
    mkdirSync(namedDir);

    applyPendingMigrations(workspace, () => {});

    expect(existsSync(uuidDir)).toBe(false);
    expect(existsSync(namedDir)).toBe(true);
  });

  it("v1-uuid-snapshots leaves non-UUID names alone even if hexish", () => {
    const dirs = ["abc", "deadbeef", "0123456789abcdef0123456789abcdef"]; // wrong shape
    for (const d of dirs) mkdirSync(join(workspace, d));

    applyPendingMigrations(workspace, () => {});

    for (const d of dirs) {
      expect(existsSync(join(workspace, d))).toBe(true);
    }
  });

  it("v1-legacy-dot-first-tree removes <ws>/.first-tree/ if present", () => {
    const dotFirstTree = join(workspace, ".first-tree");
    mkdirSync(join(dotFirstTree, "tmp"), { recursive: true });

    applyPendingMigrations(workspace, () => {});

    expect(existsSync(dotFirstTree)).toBe(false);
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
