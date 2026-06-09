import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
    mkdirSync(join(workspace, ".first-tree-workspace"), { recursive: true });
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

    applyPendingMigrations(workspace, () => {}, { currentSourceRepoNames: new Set() });

    expect(existsSync(uuidDir)).toBe(false);
    expect(existsSync(namedDir)).toBe(true);
  });

  it("v1-uuid-snapshots DEFERS on first cache-miss start when no managed state exists (PR #869 baixiaohang round-4 P0)", () => {
    // The edge case round-4 review flagged: a UUID-shaped CURRENT source repo
    // whose cloned content ships an AGENTS.md would match the legacy
    // snapshot signature. Without the defer rule, the first cache-miss start
    // would `rm` it before any resolved payload could write managed.json.
    const uuidDir = join(workspace, "12345678-abcd-4def-89ab-1234567890ab");
    mkdirSync(uuidDir);
    writeFileSync(join(uuidDir, "AGENTS.md"), "# this content-bundled file matches the legacy signature\n");
    const logs: string[] = [];

    const result = applyPendingMigrations(workspace, (msg) => logs.push(msg));

    expect(existsSync(uuidDir)).toBe(true);
    expect(existsSync(join(uuidDir, "AGENTS.md"))).toBe(true);
    expect(result.deferred).toContain("v1-uuid-snapshots");
    expect(logs.some((l) => l.includes("v1-uuid-snapshots deferred"))).toBe(true);
  });

  it("v1-uuid-snapshots STILL DEFERS when ctx is null even if persisted state is non-empty (PR #869 baixiaohang round-5 P0)", () => {
    // Round-3/4 had a graceful fallback to persisted `managed.json` when ctx
    // was null; round-5 closed that path because persisted state reflects a
    // PREVIOUS config, not the current one — a fresh config edit followed by
    // a cache miss would otherwise see the new repo as "absent" and `rm` it.
    const uuidDir = join(workspace, "12345678-abcd-4def-89ab-1234567890ab");
    mkdirSync(uuidDir);
    writeFileSync(join(uuidDir, "AGENTS.md"), "# legacy snapshot\n");
    writeFileSync(
      join(workspace, ".first-tree-workspace", "managed.json"),
      JSON.stringify({
        schemaVersion: 1,
        cliVersion: "test",
        updatedAt: new Date().toISOString(),
        sourceRepos: ["first-tree"],
        skills: [],
      }),
    );

    const result = applyPendingMigrations(workspace, () => {});

    expect(result.deferred).toContain("v1-uuid-snapshots");
    expect(existsSync(uuidDir)).toBe(true);
  });

  it("v1-uuid-snapshots leaves UUID-named directories WITHOUT the legacy snapshot signature alone (PR #869 P0)", () => {
    // A user-created UUID-named directory (no AGENTS.md / CLAUDE.md at root)
    // must not be deleted — the migration is scoped to the per-chat-cwd shape.
    const userUuidDir = join(workspace, "abcdef01-2345-4789-abcd-ef0123456789");
    mkdirSync(userUuidDir);
    writeFileSync(join(userUuidDir, "user-data.json"), "{}");

    // Pass an authoritative empty set so the migration actually runs (rather
    // than deferring on unknown config) — proving the signature check, not
    // the defer fallback, is what spares this directory.
    applyPendingMigrations(workspace, () => {}, { currentSourceRepoNames: new Set() });

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
      join(workspace, ".first-tree-workspace", "managed.json"),
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

    applyPendingMigrations(workspace, () => {}, { currentSourceRepoNames: new Set() });

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

    // Authoritative empty set → not deferred → broken-pointer check fires
    // and removes the clone. Without an explicit set, the migration defers
    // (round-4 P0 protection).
    applyPendingMigrations(workspace, () => {}, { currentSourceRepoNames: new Set() });

    expect(existsSync(target)).toBe(false);
  });

  it("v1-retired-source-repo-first-tree-hub DEFERS on first cache-miss start when no managed state exists (PR #869 baixiaohang round-4 follow-on)", () => {
    // Mirrors the v1-orphan-ft-clones / v1-uuid-snapshots defer paths: if
    // the caller can't prove first-tree-hub is absent from current config,
    // leave it alone and retry next session.
    const target = join(workspace, "first-tree-hub");
    mkdirSync(target);
    writeFileSync(join(target, ".git"), "gitdir: /tmp/does-not-exist/worktrees/first-tree-hub\n");

    const result = applyPendingMigrations(workspace, () => {});

    expect(existsSync(target)).toBe(true);
    expect(result.deferred).toContain("v1-retired-source-repo-first-tree-hub");
  });

  it("v1-retired-source-repo-first-tree-hub does NOT remove `first-tree-hub/` if it's still in current source_repos", () => {
    const target = join(workspace, "first-tree-hub");
    mkdirSync(target);
    writeFileSync(join(target, ".git"), "gitdir: /tmp/somewhere\n");
    writeFileSync(
      join(workspace, ".first-tree-workspace", "managed.json"),
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

    applyPendingMigrations(workspace, () => {}, { currentSourceRepoNames: new Set() });

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

    applyPendingMigrations(workspace, () => {}, { currentSourceRepoNames: new Set() });

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

    applyPendingMigrations(workspace, () => {}, { currentSourceRepoNames: new Set() });

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

    // Pass an authoritative empty set so the migration runs (rather than
    // deferring on unknown config) and we actually exercise the dirty guard.
    applyPendingMigrations(workspace, () => {}, { currentSourceRepoNames: new Set() });

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
    // The authoritative current set comes from the caller's ctx — an
    // explicit empty Set says "config genuinely has zero repos", which lets
    // the migration treat every FT-origin clone as orphaned.
    applyPendingMigrations(workspace, () => {}, { currentSourceRepoNames: new Set() });

    expect(existsSync(join(workspace, "first-tree-hub"))).toBe(false);
  });

  it("v1-orphan-ft-clones leaves a clone in current source_repos alone", () => {
    initRepo(join(workspace, "first-tree"), "https://github.com/agent-team-foundation/first-tree");

    applyPendingMigrations(workspace, () => {}, { currentSourceRepoNames: new Set(["first-tree"]) });

    expect(existsSync(join(workspace, "first-tree", ".git"))).toBe(true);
  });

  it("v1-orphan-ft-clones leaves non-FT-origin clones alone", () => {
    initRepo(join(workspace, "user-side-clone"), "https://github.com/some-other-org/their-repo");

    applyPendingMigrations(workspace, () => {}, { currentSourceRepoNames: new Set() });

    expect(existsSync(join(workspace, "user-side-clone", ".git"))).toBe(true);
  });

  it("v1-orphan-ft-clones skips dotfile-prefixed entries and worktrees/notes", () => {
    initRepo(join(workspace, "worktrees"), "https://github.com/agent-team-foundation/anything");
    initRepo(join(workspace, "notes"), "https://github.com/agent-team-foundation/anything");
    initRepo(join(workspace, ".some-hidden"), "https://github.com/agent-team-foundation/anything");

    applyPendingMigrations(workspace, () => {}, { currentSourceRepoNames: new Set() });

    expect(existsSync(join(workspace, "worktrees", ".git"))).toBe(true);
    expect(existsSync(join(workspace, "notes", ".git"))).toBe(true);
    expect(existsSync(join(workspace, ".some-hidden", ".git"))).toBe(true);
  });

  it("v1-orphan-ft-clones DEFERS when the live config is unresolved AND state has no source repos (PR #869 baixiaohang round-3 P0)", () => {
    // The regression code-reviewer flagged: on a legacy workspace's first
    // upgraded start with a cache-miss, ctx.currentSourceRepoNames is null
    // AND `.agent/managed.json` has not been written yet by a resolved
    // `prepareSourceRepos` run, so the persisted set is also empty. The
    // migration must defer and leave the clone untouched, not treat the
    // empty-fallback as "config truly has no repos".
    initRepo(join(workspace, "first-tree"), "https://github.com/agent-team-foundation/first-tree");
    const logs: string[] = [];

    const result = applyPendingMigrations(workspace, (msg) => logs.push(msg));

    expect(existsSync(join(workspace, "first-tree", ".git"))).toBe(true);
    expect(result.deferred).toContain("v1-orphan-ft-clones");
    // Marker MUST NOT record the deferred id — the next resolved session
    // gets another shot.
    const markerPath = join(workspace, MIGRATIONS_APPLIED_REL);
    if (existsSync(markerPath)) {
      const marker = JSON.parse(readFileSync(markerPath, "utf-8")) as { applied: string[] };
      expect(marker.applied).not.toContain("v1-orphan-ft-clones");
    }
    expect(logs.some((l) => l.includes("v1-orphan-ft-clones deferred"))).toBe(true);
  });

  it("v1-orphan-ft-clones STILL DEFERS when ctx is null even if persisted state is non-empty (PR #869 baixiaohang round-5 P0)", () => {
    // Same regression as the UUID test above: previous "graceful fallback to
    // persisted state" path was racy — a fresh web-console add could be
    // misidentified as orphan if cache missed before the new repo's name
    // landed in `managed.json`. Defer instead and retry next resolved session.
    initRepo(join(workspace, "first-tree-hub"), "https://github.com/agent-team-foundation/first-tree-hub");
    initRepo(join(workspace, "first-tree"), "https://github.com/agent-team-foundation/first-tree");
    writeFileSync(
      join(workspace, ".first-tree-workspace", "managed.json"),
      JSON.stringify({
        schemaVersion: 1,
        cliVersion: "test",
        updatedAt: new Date().toISOString(),
        sourceRepos: ["first-tree"],
        skills: [],
      }),
    );

    const result = applyPendingMigrations(workspace, () => {});

    expect(result.deferred).toContain("v1-orphan-ft-clones");
    expect(existsSync(join(workspace, "first-tree", ".git"))).toBe(true);
    expect(existsSync(join(workspace, "first-tree-hub"))).toBe(true);
  });

  it("v1-orphan-skills removes hardcoded legacy skill payloads + matching .claude symlinks", () => {
    // Plant each of the 6 retired skills on disk in the canonical layout
    // (`.agents/skills/<name>/SKILL.md` + `.claude/skills/<name>` symlink).
    // The migration must remove all of them in one pass.
    const legacy = [
      "attention",
      "first-tree-cloud",
      "first-tree-github-scan",
      "first-tree-onboarding",
      "first-tree-write",
      "github-scan",
    ];
    mkdirSync(join(workspace, ".claude", "skills"), { recursive: true });
    for (const name of legacy) {
      const agentsDir = join(workspace, ".agents", "skills", name);
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, "SKILL.md"), `---\nname: ${name}\n---\nstale ${name}\n`);
      symlinkSync(join("..", "..", ".agents", "skills", name), join(workspace, ".claude", "skills", name));
    }

    const result = applyPendingMigrations(workspace, () => {}, { currentSourceRepoNames: new Set() });

    for (const name of legacy) {
      expect(existsSync(join(workspace, ".agents", "skills", name))).toBe(false);
      // The symlink itself should be gone, not just dangling.
      expect(() => lstatSync(join(workspace, ".claude", "skills", name))).toThrow();
    }
    expect(result.applied).toContain("v1-orphan-skills");
  });

  it("v1-orphan-skills leaves current skill payloads alone (only the hardcoded historical list matches)", () => {
    // Plant a currently-bundled skill alongside one of the legacy names.
    // The current skill must survive; the legacy one must go.
    mkdirSync(join(workspace, ".claude", "skills"), { recursive: true });
    const currentName = "first-tree-context"; // still in TREE_SKILL_NAMES
    const legacyName = "first-tree-cloud"; // retired
    for (const name of [currentName, legacyName]) {
      const agentsDir = join(workspace, ".agents", "skills", name);
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(join(agentsDir, "SKILL.md"), `---\nname: ${name}\n---\n`);
      symlinkSync(join("..", "..", ".agents", "skills", name), join(workspace, ".claude", "skills", name));
    }

    applyPendingMigrations(workspace, () => {}, { currentSourceRepoNames: new Set() });

    expect(existsSync(join(workspace, ".agents", "skills", currentName, "SKILL.md"))).toBe(true);
    expect(lstatSync(join(workspace, ".claude", "skills", currentName)).isSymbolicLink()).toBe(true);
    expect(existsSync(join(workspace, ".agents", "skills", legacyName))).toBe(false);
  });

  it("v1-orphan-skills does NOT remove a `.claude/skills/<legacy>` entry that's a regular directory (not a symlink)", () => {
    // A user-authored regular directory at the Claude path — the migration
    // unlinks ONLY when the entry is a symbolic link, so this should
    // survive. The `.agents/skills/<legacy>/` payload (if any) is still
    // removed because that path IS owned by the CLI by convention.
    const name = "attention";
    const claudeDir = join(workspace, ".claude", "skills", name);
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "user-content.md"), "# my notes\n");

    applyPendingMigrations(workspace, () => {}, { currentSourceRepoNames: new Set() });

    expect(existsSync(claudeDir)).toBe(true);
    expect(existsSync(join(claudeDir, "user-content.md"))).toBe(true);
  });
});

describe("applyPendingMigrations applier", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "workspace-migrations-applier-test-"));
    mkdirSync(join(workspace, ".first-tree-workspace"), { recursive: true });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("records applied ids in .agent/migrations-applied.json after a run", () => {
    const ran: string[] = [];
    const registry: readonly Migration[] = [
      {
        id: "test-alpha",
        description: "",
        apply: () => {
          ran.push("alpha");
        },
      },
      {
        id: "test-beta",
        description: "",
        apply: () => {
          ran.push("beta");
        },
      },
    ];

    const result = applyPendingMigrations(workspace, () => {}, { currentSourceRepoNames: null }, registry);

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
      {
        id: "test-alpha",
        description: "",
        apply: () => {
          ran.push("alpha");
        },
      },
      {
        id: "test-beta",
        description: "",
        apply: () => {
          ran.push("beta");
        },
      },
    ];

    const result = applyPendingMigrations(workspace, () => {}, { currentSourceRepoNames: null }, registry);

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
    const result = applyPendingMigrations(
      workspace,
      (msg) => logs.push(msg),
      { currentSourceRepoNames: null },
      registry,
    );

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

    applyPendingMigrations(workspace, () => {}, { currentSourceRepoNames: null }, registry);

    const after = readFileSync(join(workspace, MIGRATIONS_APPLIED_REL), "utf-8");
    expect(after).toBe(before);
  });

  it("treats a malformed marker as empty (re-applies all)", () => {
    writeFileSync(join(workspace, MIGRATIONS_APPLIED_REL), "{ not json");
    const ran: string[] = [];
    const registry: readonly Migration[] = [
      {
        id: "test-alpha",
        description: "",
        apply: () => {
          ran.push("alpha");
        },
      },
    ];

    const result = applyPendingMigrations(workspace, () => {}, { currentSourceRepoNames: null }, registry);

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
