// One-shot workspace migrations for legacy directory-structure changes.
//
// Background: between First Tree's per-chat-cwd era and the current
// per-agent-home model, the workspace layout changed several times. Old
// workspaces accumulate stale top-level dirs (`.first-tree/` state dir,
// UUID-named chat snapshots, retired source-repo clones like
// `first-tree-hub/`, a `WHITEPAPER.md` symlink that used to point at a
// repo-local skill payload). The state-based delete-on-removal in
// `managed-state` only catches resources THIS CLI installed and later
// dropped; legacy residue predates the state file entirely and has to
// be cleaned with a one-shot sweep.
//
// Design:
//
//   - Each migration has a stable `id`. The set of already-applied ids is
//     persisted to `.agent/migrations-applied.json` so each migration runs
//     at most once per workspace, even if it's later removed from the
//     registry (the marker stays as forward protection).
//   - Migrations are idempotent — re-running a migration on an already-
//     clean workspace is a noop. Marker file is the optimisation, not the
//     correctness boundary.
//   - Migrations log to `sessionCtx.log` (passed in by the caller).
//   - One migration's failure does NOT block the rest; failures are logged
//     and the marker is NOT recorded for that id (so a future run retries).

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type RemoveCloneOutcome, tryRemoveCloneSafely } from "./source-repo-cleanup.js";
import { isSourceRepoPathInUse } from "./source-repos.js";

/**
 * Path inside the agent home where {@link applyPendingMigrations} persists
 * the set of already-applied migration ids.
 */
export const MIGRATIONS_APPLIED_REL = join(".agent", "migrations-applied.json");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Origin URLs matching this prefix are treated as First-Tree-managed —
 *  the orphan-clone migration uses it to scope deletion to clones FT
 *  itself planted, never user-cloned third-party repos. */
const FT_ORIGIN_RE = /github\.com[/:]agent-team-foundation\//i;

export type MigrationLog = (msg: string) => void;

export type Migration = {
  /** Stable identifier persisted to the marker file. Never re-use across
   *  migrations even when one is retired. */
  id: string;
  description: string;
  /** Idempotent action. Throws on failure; the applier catches and skips
   *  the marker write so a future run retries. */
  apply: (workspacePath: string, log: MigrationLog) => void;
};

// ─── Utilities ────────────────────────────────────────────────────────

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Unlink a symbolic link at `path`, returning `true` only when the entry
 * existed AND was a symlink (NOT a real file or directory). Callers use
 * this for legacy-symlink cleanup so a user-authored regular file with
 * the same name is never deleted by mistake.
 */
function unlinkSymlinkIfExists(path: string): boolean {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return false;
  }
  if (!stat.isSymbolicLink()) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recognise the legacy per-chat-cwd snapshot shape: a workspace-root UUID
 * directory that carries a top-level briefing file (`AGENTS.md` or
 * `CLAUDE.md`), as the old per-chat handlers always materialised. A plain
 * UUID-named directory without that signature is treated as user content
 * and left alone.
 *
 * The check is intentionally cheap (one or two `existsSync` calls) — it
 * runs at most once per workspace per id (the migrations applier
 * deduplicates) so a deeper scan isn't justified.
 */
function hasLegacySnapshotSignature(dir: string): boolean {
  return existsSync(join(dir, "AGENTS.md")) || existsSync(join(dir, "CLAUDE.md"));
}

function readGitOrigin(repoDir: string): string | null {
  const gitDir = join(repoDir, ".git");
  if (!existsSync(gitDir)) return null;
  try {
    return execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: repoDir,
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

// ─── Migration registry ───────────────────────────────────────────────

/**
 * Ordered list of one-shot migrations. New entries land at the END with a
 * fresh `vN-*` id; existing ids stay even when their bodies are simplified
 * so already-migrated workspaces keep their marker.
 */
export const MIGRATIONS_REGISTRY: readonly Migration[] = [
  {
    id: "v1-uuid-snapshots",
    description:
      "Remove legacy UUID-named per-chat snapshot directories at workspace root. Per PR #869 baixiaohang P0: scoped to entries that BOTH match the UUID shape AND carry the legacy snapshot signature (a top-level `AGENTS.md` / `CLAUDE.md` file from when each chat had a self-contained cwd). Also skips anything currently listed in `.agent/managed.json::sourceRepos` so a user with a UUID-shaped `gitRepos.localPath` is never deleted.",
    apply: (workspacePath, log) => {
      const currentRepos = readCurrentSourceRepoNames(workspacePath);
      let removed = 0;
      let skipped = 0;
      for (const name of safeReaddir(workspacePath)) {
        if (!UUID_RE.test(name)) continue;
        const full = join(workspacePath, name);
        if (!isDirectory(full)) continue;
        if (currentRepos.has(name)) {
          // A legit current source repo whose `localPath` happens to look like
          // a UUID — never delete.
          skipped += 1;
          continue;
        }
        if (!hasLegacySnapshotSignature(full)) {
          // No `AGENTS.md` / `CLAUDE.md` at this UUID dir's root → not the
          // old per-chat-cwd shape. Probably user content. Leave alone.
          skipped += 1;
          continue;
        }
        rmSync(full, { recursive: true, force: true });
        removed += 1;
      }
      if (removed > 0) {
        log(`workspace-migrations: v1-uuid-snapshots removed ${removed} legacy snapshot dir(s)`);
      }
      if (skipped > 0) {
        log(
          `workspace-migrations: v1-uuid-snapshots skipped ${skipped} UUID-named dir(s) without the legacy snapshot signature`,
        );
      }
    },
  },
  {
    id: "v1-retired-source-repo-first-tree-hub",
    description:
      "Remove <ws>/first-tree-hub/ — a retired First-Tree source repo. Narrowly scoped to the broken-pointer shape the legacy hub-worktree model left behind: `.git` is a regular FILE (not a directory) with `gitdir: <path>` whose target no longer exists on disk. In that shape, `git config --get remote.origin.url` exits 128 and the general `v1-orphan-ft-clones` sweep can't identify the clone by origin URL — and the local git state is unusable anyway, so there's no recoverable work to lose. Healthy `first-tree-hub/` clones (with `.git/` as a real directory) defer to `v1-orphan-ft-clones`, which goes through `tryRemoveCloneSafely` with the dirty / ahead / worktree guards. PR #869 code-reviewer P0-1.",
    apply: (workspacePath, log) => {
      const target = join(workspacePath, "first-tree-hub");
      if (!existsSync(target) || !isDirectory(target)) return;
      // Skip if `first-tree-hub` is in the agent's current source-repos
      // config — a future re-add would otherwise lose its checkout.
      if (readCurrentSourceRepoNames(workspacePath).has("first-tree-hub")) {
        log(
          "workspace-migrations: v1-retired-source-repo-first-tree-hub skipped — still in current source repos config",
        );
        return;
      }
      const gitEntry = join(target, ".git");
      let gitStat: ReturnType<typeof lstatSync>;
      try {
        gitStat = lstatSync(gitEntry);
      } catch {
        // No `.git` → not a clone (user content, or already cleaned).
        return;
      }
      if (gitStat.isDirectory()) {
        // Healthy clone — `v1-orphan-ft-clones` will inspect it through
        // `tryRemoveCloneSafely` with the dirty / ahead / worktree guards.
        // Skip here to avoid duplicating that path.
        return;
      }
      // `.git` is a regular file (the pointer shape). Read it and confirm
      // the gitdir target is gone — that's what makes the clone "broken
      // legacy" rather than a healthy `git worktree add` linked checkout
      // a future feature might rely on.
      let pointerTarget: string | null = null;
      try {
        const pointerContent = readFileSync(gitEntry, "utf-8");
        const match = pointerContent.match(/^gitdir:\s*(.+)$/m);
        if (match?.[1]) pointerTarget = match[1].trim();
      } catch {
        return;
      }
      if (pointerTarget === null) {
        log("workspace-migrations: v1-retired-source-repo-first-tree-hub skipped — `.git` file has unexpected shape");
        return;
      }
      if (existsSync(pointerTarget)) {
        log(
          `workspace-migrations: v1-retired-source-repo-first-tree-hub skipped — \`.git\` pointer target ${pointerTarget} still exists (live worktree)`,
        );
        return;
      }
      rmSync(target, { recursive: true, force: true });
      log(
        "workspace-migrations: v1-retired-source-repo-first-tree-hub removed first-tree-hub/ (broken `.git` pointer)",
      );
    },
  },
  // NOTE: a `v1-legacy-dot-first-tree` migration was proposed but withdrawn
  // during Codex review (PR #869, P1 from baixiaohang). The directory
  // `<workspace>/.first-tree/` is the active W1 binding state (it holds
  // `workspace.json`, see `packages/shared/src/schemas/workspace-manifest.ts`
  // → `WORKSPACE_STATE_DIRNAME`). A blind sweep would silently unbind every
  // upgraded W1 workspace. The residue this migration was meant to catch
  // (`<workspace>/.first-tree/tmp/` from a much older client) is tiny and
  // can be revisited as a precision-scoped migration later if it becomes a
  // real problem; the savings did not justify the data-loss risk.
  {
    id: "v1-whitepaper-symlink",
    description: "Remove legacy WHITEPAPER.md (root-level symlink that used to expose a skill payload)",
    apply: (workspacePath, log) => {
      // Only remove when the entry is actually a symlink — a user-authored
      // regular WHITEPAPER.md file at workspace root must NOT be deleted by
      // an upgrade-time cleanup pass. (Codex review nit P2 on PR #869.)
      const target = join(workspacePath, "WHITEPAPER.md");
      if (unlinkSymlinkIfExists(target)) {
        log("workspace-migrations: v1-whitepaper-symlink removed WHITEPAPER.md");
      }
    },
  },
  {
    id: "v1-orphan-ft-clones",
    description:
      "Remove top-level clones whose `.git/config` origin points at agent-team-foundation/* but are not in the workspace's current source-repos config (catches retired source repos like first-tree-hub). Same dirty / ahead-of-upstream / worktree guards as the state-based source cleanup — Codex review P1 on PR #869.",
    apply: (workspacePath, log) => {
      const currentRepos = readCurrentSourceRepoNames(workspacePath);
      let removed = 0;
      let skipped = 0;
      for (const name of safeReaddir(workspacePath)) {
        // Workspace-meta dirs and the agent-self-managed dirs never have a
        // `.git/` so they're filtered by the origin probe below; skip them
        // here just to keep the loop body cheap.
        if (name.startsWith(".") || name === "worktrees" || name === "notes") continue;
        const full = join(workspacePath, name);
        if (!isDirectory(full)) continue;
        if (currentRepos.has(name)) continue;
        const origin = readGitOrigin(full);
        if (origin === null) continue;
        if (!FT_ORIGIN_RE.test(origin)) continue;
        const outcome: RemoveCloneOutcome = tryRemoveCloneSafely(
          full,
          `${name}/ (origin ${origin})`,
          log,
          isSourceRepoPathInUse,
        );
        if (outcome === "removed") {
          removed += 1;
        } else if (outcome !== "absent" && outcome !== "not-a-clone") {
          // dirty / ahead-of-upstream / has-worktrees / probe-failed /
          // remove-failed — `tryRemoveCloneSafely` already logged the reason;
          // count as "left behind" for the summary line below.
          skipped += 1;
        }
      }
      if (removed > 0 && skipped === 0) {
        log(`workspace-migrations: v1-orphan-ft-clones removed ${removed} orphan clone(s)`);
      } else if (skipped > 0) {
        log(
          `workspace-migrations: v1-orphan-ft-clones removed ${removed} orphan clone(s); ${skipped} held back by safety guards — operator follow-up`,
        );
      }
    },
  },
];

/**
 * Read the names of source repos currently materialised in this workspace,
 * by inspecting the previously-recorded managed state. Used by
 * `v1-orphan-ft-clones` to avoid deleting clones the state-based machinery
 * still tracks.
 *
 * Returns an empty set when no state file exists — at that point the
 * orphan-clone migration is being asked to run on a brand-new workspace,
 * which can't have orphans anyway, so the conservative empty set is fine.
 *
 * Imported lazily (require-style) to keep this module free of cross-file
 * cycles — `managed-state` already imports node:fs which keeps the
 * dependency direction one-way.
 */
function readCurrentSourceRepoNames(workspacePath: string): Set<string> {
  // Inline read instead of importing readManagedState to avoid a cycle
  // when this module is loaded as part of the bootstrap path that also
  // pulls in managed-state.
  const statePath = join(workspacePath, ".agent", "managed.json");
  if (!existsSync(statePath)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf-8")) as unknown;
    if (typeof raw !== "object" || raw === null) return new Set();
    const record = raw as Record<string, unknown>;
    if (!Array.isArray(record.sourceRepos)) return new Set();
    return new Set(record.sourceRepos.filter((entry): entry is string => typeof entry === "string"));
  } catch {
    return new Set();
  }
}

// ─── Applier ─────────────────────────────────────────────────────────

type AppliedRecord = {
  schemaVersion: 1;
  applied: string[];
};

function readAppliedRecord(workspacePath: string): AppliedRecord {
  const path = join(workspacePath, MIGRATIONS_APPLIED_REL);
  if (!existsSync(path)) return { schemaVersion: 1, applied: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return { schemaVersion: 1, applied: [] };
    const record = parsed as Record<string, unknown>;
    if (record.schemaVersion !== 1) return { schemaVersion: 1, applied: [] };
    const applied = Array.isArray(record.applied)
      ? record.applied.filter((entry): entry is string => typeof entry === "string")
      : [];
    return { schemaVersion: 1, applied };
  } catch {
    return { schemaVersion: 1, applied: [] };
  }
}

function writeAppliedRecord(workspacePath: string, record: AppliedRecord): void {
  mkdirSync(join(workspacePath, ".agent"), { recursive: true });
  const finalPath = join(workspacePath, MIGRATIONS_APPLIED_REL);
  const tempPath = `${finalPath}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
  try {
    renameSync(tempPath, finalPath);
  } catch (err) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup — surface the original rename failure.
    }
    throw err;
  }
}

export type ApplyMigrationsResult = {
  /** Ids whose apply ran cleanly this call (newly applied). */
  applied: readonly string[];
  /** Ids skipped because the marker file already lists them. */
  skipped: readonly string[];
  /** Ids whose apply threw — marker NOT written so a future run retries. */
  failed: ReadonlyArray<{ id: string; reason: string }>;
};

/**
 * Run every registry migration whose id is not in the marker file. Writes
 * the updated marker after the registry walk so a crash mid-loop only
 * loses the in-flight migration (the future run picks up where this one
 * left off).
 *
 * Order-of-operations: the applier walks `MIGRATIONS_REGISTRY` in array
 * order. Migrations are designed to be order-independent (each targets a
 * different file/directory pattern) so this matters only for log
 * readability.
 */
export function applyPendingMigrations(
  workspacePath: string,
  log: MigrationLog,
  registry: readonly Migration[] = MIGRATIONS_REGISTRY,
): ApplyMigrationsResult {
  const record = readAppliedRecord(workspacePath);
  const alreadyApplied = new Set(record.applied);
  const newlyApplied: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ id: string; reason: string }> = [];

  for (const migration of registry) {
    if (alreadyApplied.has(migration.id)) {
      skipped.push(migration.id);
      continue;
    }
    try {
      migration.apply(workspacePath, log);
      newlyApplied.push(migration.id);
      alreadyApplied.add(migration.id);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failed.push({ id: migration.id, reason });
      log(`workspace-migrations: ${migration.id} FAILED (${reason.slice(0, 200)})`);
    }
  }

  if (newlyApplied.length > 0) {
    writeAppliedRecord(workspacePath, {
      schemaVersion: 1,
      applied: [...alreadyApplied].sort(),
    });
  }

  return { applied: newlyApplied, skipped, failed };
}
