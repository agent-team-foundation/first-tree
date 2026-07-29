// Atomic JSON record of the resources the CLI currently manages inside an
// agent workspace. Used by the next session start to detect "previously
// managed but no longer in current config" → delete.
//
// Scope is deliberately narrow: a list of skill names. Anything else CLI
// puts in the workspace (AGENTS.md, .first-tree-workspace/identity.json,
// .claude/skills symlinks, etc.) is owned by other flows and not tracked
// here. (Source repos and the Context Tree clone are agent-managed; the
// runtime never deletes a repo clone, so they carry no managed-state entry.
// A legacy record that still carries the retired `sourceRepos` key reads
// fine — the reader ignores unknown keys and keeps `schemaVersion` at 1.)
//
// Path-level precision: the diff is "prev∖current" → delete. The flip side
// (names in `current` and not in `prev`) is handled by the existing
// installer (`installFirstTreeSkills`), which already (re)materialises
// everything it expects to be present.
//
// Trust: this file lives inside the agent workspace and is agent-writable,
// so every read treats it as untrusted input — `skills` entries are checked
// against {@link isManagedSkillName} before they can reach any filesystem
// operation (#1610).

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The per-agent runtime directory name. Mirrors `bootstrap.ts ::
 * FIRST_TREE_RUNTIME_DIR` (which itself aliases `FIRST_TREE_WORKSPACE_MARKER`);
 * inlined as a literal here to avoid a top-level import cycle
 * (`bootstrap` → `first-tree-skills/installer` → `managed-state` →
 * `bootstrap` would evaluate the constant before bootstrap finishes
 * initialising, leaving it `undefined`). Keep in sync with the source of
 * truth in `bootstrap.ts`.
 */
const RUNTIME_DIR = ".first-tree-workspace";

/**
 * Path inside the agent home where {@link readManagedState} /
 * {@link writeManagedState} persist the record. Lives alongside
 * `identity.json`, `cli-version`, etc. — same per-agent runtime-dir
 * convention every other client-owned state file uses.
 */
export const MANAGED_STATE_REL = join(RUNTIME_DIR, "managed.json");

/**
 * Strict slug schema for a managed skill name: a single lowercase
 * kebab-case path segment (max 63 chars). Matches the slug convention used
 * across the repo (e.g. `packages/shared/src/schemas/organization.ts`) and
 * covers every current and historical First Tree skill name. Anything else
 * — absolute paths, `..` segments, path separators, control characters,
 * drive letters — is rejected, so an accepted name can never escape its
 * parent directory when joined into a path.
 */
const MANAGED_SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Whether `name` is a valid managed skill slug. The managed-state file is
 * agent-writable and therefore untrusted input (#1610): every name read
 * from it must pass this check before reaching a filesystem operation.
 * Rejection is fail-safe — an unrecognised name is simply never
 * auto-removed and stays on disk.
 */
export function isManagedSkillName(name: string): boolean {
  return MANAGED_SKILL_NAME_PATTERN.test(name);
}

/**
 * Schema-versioned record of the resources the CLI currently manages in a
 * workspace. `schemaVersion` is checked on read; anything else makes the
 * read return null (treated as "first run", no deletions performed).
 */
export type ManagedState = {
  schemaVersion: 1;
  /** CLI version that wrote this record. Informational only — the diff
   *  logic doesn't gate on it. */
  cliVersion: string | null;
  /** ISO timestamp of the last write. */
  updatedAt: string;
  /** Skill names currently installed under `.agents/skills/<name>/` (and
   *  symlinked at `.claude/skills/<name>`). */
  skills: string[];
};

/**
 * Read the managed-state record. Returns `null` when the file is missing,
 * unreadable, malformed JSON, or written by a future schema this code
 * doesn't understand — callers treat null as "first run on this workspace"
 * and perform no deletions.
 *
 * The file is agent-writable, so its content is untrusted input (#1610):
 * `skills` entries that are not valid skill slugs ({@link isManagedSkillName})
 * are dropped on read, keeping path-traversal names away from the reconcile
 * deletion path.
 */
export function readManagedState(workspacePath: string): ManagedState | null {
  const path = join(workspacePath, MANAGED_STATE_REL);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== 1) return null;
  const skills = readStringArray(record.skills).filter(isManagedSkillName);
  const cliVersion = typeof record.cliVersion === "string" ? record.cliVersion : null;
  const updatedAt = typeof record.updatedAt === "string" ? record.updatedAt : new Date(0).toISOString();
  return { schemaVersion: 1, cliVersion, updatedAt, skills };
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Atomically persist the managed-state record. Writes to a unique sibling
 * temp file then `rename`s onto the final path — POSIX makes that atomic,
 * so a concurrent reader either sees the old record in full or the new one
 * in full, never a partial write.
 *
 * Temp file is cleaned up on rename failure so a crashed write does not
 * leak siblings.
 */
export function writeManagedState(workspacePath: string, state: ManagedState): void {
  mkdirSync(join(workspacePath, RUNTIME_DIR), { recursive: true });
  const finalPath = join(workspacePath, MANAGED_STATE_REL);
  const tempPath = `${finalPath}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
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

/**
 * Read-modify-write helper for partial updates. Applies `mutator` to the
 * current state (or an empty default when none exists), then atomically
 * persists the result. Callers do NOT need to handle the file-missing
 * case — the mutator always receives a well-formed {@link ManagedState}.
 *
 * Concurrency note: the workspace is per-agent, sessions inside that
 * workspace are serialised by AgentSlot, so two concurrent updates on the
 * same file are not expected. The atomic `rename` still provides
 * crash-safety for the single-writer case.
 */
export function updateManagedState(
  workspacePath: string,
  cliVersion: string | null,
  mutator: (current: ManagedState) => ManagedState,
): ManagedState {
  const current: ManagedState = readManagedState(workspacePath) ?? {
    schemaVersion: 1,
    cliVersion,
    updatedAt: new Date(0).toISOString(),
    skills: [],
  };
  const next = mutator(current);
  const persisted: ManagedState = {
    ...next,
    schemaVersion: 1,
    cliVersion,
    updatedAt: new Date().toISOString(),
  };
  writeManagedState(workspacePath, persisted);
  return persisted;
}
