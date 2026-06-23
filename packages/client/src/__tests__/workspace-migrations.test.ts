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
        skills: ["first-tree"],
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

  it("v1-uuid-snapshots leaves a UUID-named directory that's currently in source-repo config (PR #869 P0)", () => {
    // Edge case: agent config has a `gitRepos.localPath` shaped like a UUID.
    // The migration must NOT delete it even when it has a top-level
    // AGENTS.md (e.g. the cloned repo happens to ship one) — the live
    // `currentSourceRepoNames` set spares any UUID dir still in config.
    const uuidRepo = join(workspace, "fedcba98-7654-4321-9abc-def012345678");
    mkdirSync(uuidRepo);
    writeFileSync(join(uuidRepo, "AGENTS.md"), "# this repo happens to ship AGENTS.md\n");

    // Resolved config (non-null) so the migration RUNS rather than deferring;
    // the UUID dir is spared because it's the agent's current source repo.
    applyPendingMigrations(workspace, () => {}, {
      currentSourceRepoNames: new Set(["fedcba98-7654-4321-9abc-def012345678"]),
    });

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

  it("v1-whitepaper-symlink removes WHITEPAPER.md at workspace root", () => {
    const whitepaper = join(workspace, "WHITEPAPER.md");
    // Symlink target need not resolve; the migration just unlinks.
    symlinkSync("/nonexistent", whitepaper);

    applyPendingMigrations(workspace, () => {});

    expect(existsSync(whitepaper)).toBe(false);
  });

  it("v1-orphan-skills removes hardcoded legacy skill payloads + matching .claude symlinks", () => {
    // Plant each retired skill on disk in the canonical layout
    // (`.agents/skills/<name>/SKILL.md` + `.claude/skills/<name>` symlink).
    // The migration must remove all of them in one pass.
    const legacy = [
      "attention",
      "first-tree-cloud",
      "first-tree-github-scan",
      "first-tree-onboarding",
      "github-scan",
      "first-tree",
      "first-tree-context",
      "first-tree-sync",
      "first-tree-github",
      "first-tree-kickoff",
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
    const currentName = "first-tree-write"; // still in TREE_SKILL_NAMES
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

  it("v1-legacy-workspace-gitignore deletes a `.gitignore` that contains only the legacy entries", () => {
    const target = join(workspace, ".gitignore");
    writeFileSync(target, ".first-tree/tmp/\n.agents/skills/\n.claude/skills/\n");

    applyPendingMigrations(workspace, () => {}, { currentSourceRepoNames: new Set() });

    expect(existsSync(target)).toBe(false);
  });

  it("v1-legacy-workspace-gitignore strips legacy entries but preserves user content", () => {
    // The retired writer UPSERTED into an existing file, so a user-authored
    // `.gitignore` can carry the legacy entries alongside the user's own
    // patterns. Only the legacy lines go; the rest stays.
    const target = join(workspace, ".gitignore");
    writeFileSync(target, "node_modules/\n.first-tree/tmp/\n.agents/skills/\n.claude/skills/\n*.log\n");

    applyPendingMigrations(workspace, () => {}, { currentSourceRepoNames: new Set() });

    expect(readFileSync(target, "utf-8")).toBe("node_modules/\n*.log\n");
  });

  it("v1-legacy-workspace-gitignore leaves a user `.gitignore` without legacy entries untouched", () => {
    const target = join(workspace, ".gitignore");
    const content = "node_modules/\ndist/\n";
    writeFileSync(target, content);

    applyPendingMigrations(workspace, () => {}, { currentSourceRepoNames: new Set() });

    expect(readFileSync(target, "utf-8")).toBe(content);
  });

  it("v1-legacy-workspace-gitignore is a noop when no `.gitignore` exists", () => {
    const result = applyPendingMigrations(workspace, () => {}, { currentSourceRepoNames: new Set() });

    expect(result.applied).toContain("v1-legacy-workspace-gitignore");
    expect(existsSync(join(workspace, ".gitignore"))).toBe(false);
  });

  it("v1-legacy-workspace-gitignore also strips the older `.first-tree/local-tree.json` entry (PR #929 S1)", () => {
    // The #62 → #371 window of the retired writer included this entry. After
    // #92 consolidated config into `source.json` the line became an orphan
    // that no longer points at anything on disk; the migration must clean it
    // up alongside the later three entries.
    const target = join(workspace, ".gitignore");
    writeFileSync(target, ".first-tree/local-tree.json\n.first-tree/tmp/\n");

    applyPendingMigrations(workspace, () => {}, { currentSourceRepoNames: new Set() });

    expect(existsSync(target)).toBe(false);
  });

  it("v1-legacy-workspace-gitignore does NOT touch a `.gitignore` that is a symlink (PR #929 S2)", () => {
    // Shape-check guard — mirrors `v1-whitepaper-symlink` posture but in the
    // opposite direction: that migration unlinks ONLY symlinks; this one
    // touches ONLY regular files. A symlink at the workspace-root `.gitignore`
    // is not what the retired writer produced and must survive untouched
    // (and the target must not be read or rewritten).
    const realFile = join(workspace, "elsewhere.gitignore");
    writeFileSync(realFile, ".first-tree/tmp/\n");
    const target = join(workspace, ".gitignore");
    symlinkSync(realFile, target);

    applyPendingMigrations(workspace, () => {}, { currentSourceRepoNames: new Set() });

    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(readFileSync(realFile, "utf-8")).toBe(".first-tree/tmp/\n");
  });

  it("v1-legacy-workspace-gitignore does NOT touch a `.gitignore` that is a directory (PR #929 S2)", () => {
    // Another shape-check pair: a user-created directory at the
    // workspace-root `.gitignore` path (unusual but possible) is not the
    // legacy writer's output and must not be removed.
    const target = join(workspace, ".gitignore");
    mkdirSync(target);
    writeFileSync(join(target, "inside"), "user content\n");

    applyPendingMigrations(workspace, () => {}, { currentSourceRepoNames: new Set() });

    expect(lstatSync(target).isDirectory()).toBe(true);
    expect(readFileSync(join(target, "inside"), "utf-8")).toBe("user content\n");
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
