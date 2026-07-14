// Inline skill payload installer. Replaces the previous shell-out to
// `<binName> tree skill install --root <workspace>` so the Client owns
// the full agent-workspace bootstrap with no out-of-process dependency
// (no need for the First Tree CLI on PATH, no `npx -y first-tree@latest`
// download on first run, no channel binding to thread through).
//
// Design notes:
//
//   - Bundled skills live at `<client-pkg>/skills/<name>/`. The directory
//     is produced by `scripts/copy-bundled-skills.mjs` (prebuild) from the
//     repo-root `skills/`, and shipped inside the npm tarball via the
//     `files` field of package.json. Source-of-truth is the repo-root
//     directory; this dir is a build artifact and is .gitignore'd.
//
//   - Idempotency: per-skill VERSION file is compared between bundled
//     payload and on-disk install. Equal → skip the rm+cp+symlink for
//     that skill (cheap fast path on every session start). Missing or
//     mismatched → full reinstall of just that skill.
//
//   - Failure model mirrors the old shell-out: each skill install is
//     try/caught independently, and the function returns `false` if ANY
//     skill failed. Caller logs the failure and continues — the agent
//     session still starts, the skill just isn't on disk.

import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBundledCliVersion } from "../bootstrap.js";
import { readManagedState, updateManagedState } from "../managed-state.js";

/**
 * Skills always shipped, regardless of whether the agent has a Context Tree
 * binding. Installation is deliberately broad and cheap; generated routing and
 * each skill's workflow decide when a payload applies.
 *
 * Keeping `first-tree-read` and `first-tree-write` present in every workspace
 * avoids mid-session install churn when a tree is created while the agent is
 * already running, and keeps generated briefing rows aligned with the on-disk
 * skill set.
 */
export const CORE_SKILL_NAMES = [
  "first-tree-welcome",
  "first-tree-seed",
  "first-tree-file-bug",
  "first-tree-gitlab",
  "first-tree-read",
  "first-tree-write",
] as const;

const RETIRED_CORE_SKILL_NAMES = ["first-tree-guide", "first-tree-kickoff"] as const;

/**
 * The current installer has no separate tree-bound payload tier: all shipped
 * First Tree payloads are installed by `CORE_SKILL_NAMES`. Keep this exported
 * empty list so the historical tree-skill reconciliation path can keep pruning
 * genuinely retired managed-state entries without installing a second tier.
 * The UNION with `CORE_SKILL_NAMES` must stay in sync with `BUNDLED_SKILLS` in
 * `scripts/copy-bundled-skills.mjs`.
 */
export const TREE_SKILL_NAMES = [] as const;

export type CoreSkillName = (typeof CORE_SKILL_NAMES)[number];
export type TreeSkillName = (typeof TREE_SKILL_NAMES)[number];
export type SkillName = CoreSkillName | TreeSkillName;

export type InstallSkillsResult = {
  /** `true` when every requested skill installed or was already current. */
  ok: boolean;
  /** Skills whose on-disk VERSION matched bundled VERSION — no re-copy needed. */
  skipped: readonly string[];
  /** Skills that were copied (either fresh install or version drift). */
  installed: readonly string[];
  /** Skills whose install raised; one entry per failure. */
  failed: ReadonlyArray<{ name: string; reason: string }>;
};

type SkillLayout = {
  name: string;
  /** Absolute path of the bundled source under `<client-pkg>/skills/<name>/`. */
  sourceDir: string;
  /** Workspace-relative path of the installed payload. */
  agentsRelPath: string;
  /** Workspace-relative path of the `.claude/skills/<name>` companion entry. */
  claudeRelPath: string;
  /** Symlink target for `.claude/skills/<name>` → `../../.agents/skills/<name>`. */
  claudeSymlinkTarget: string;
};

/**
 * Walk up from the running module to find the @first-tree/client package
 * root, then return its bundled `skills/` directory. Works in both modes:
 *
 *   - dev (vitest, `pnpm --filter @first-tree/client dev`):
 *       `packages/client/src/runtime/first-tree-skills/installer.ts`
 *       → walks up to `packages/client/`
 *   - prod (npm tarball + `dist/index.mjs`):
 *       `packages/client/dist/index.mjs`
 *       → walks up to `packages/client/` (which carries `skills/` via the
 *         `files` field of package.json)
 *
 * Throws when no `skills/first-tree-write/SKILL.md` is reachable from the running
 * module. That's a build/packaging bug — prebuild was not run, or `skills/`
 * was excluded from the npm tarball.
 */
export function resolveBundledSkillsRoot(startDir?: string): string {
  let currentDir = resolve(startDir ?? dirname(fileURLToPath(import.meta.url)));
  while (true) {
    const candidate = join(currentDir, "skills", "first-tree-write", "SKILL.md");
    if (existsSync(candidate)) {
      return join(currentDir, "skills");
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(
        "Could not locate bundled `skills/` payloads. Run `pnpm --filter @first-tree/client prebuild` or check that the npm tarball includes `skills/`.",
      );
    }
    currentDir = parentDir;
  }
}

function layoutFor(name: string, bundledSkillsRoot: string): SkillLayout {
  return {
    name,
    sourceDir: join(bundledSkillsRoot, name),
    agentsRelPath: join(".agents", "skills", name),
    claudeRelPath: join(".claude", "skills", name),
    claudeSymlinkTarget: join("..", "..", ".agents", "skills", name),
  };
}

function readVersionFile(dir: string): string | null {
  const versionPath = join(dir, "VERSION");
  if (!existsSync(versionPath)) return null;
  try {
    return readFileSync(versionPath, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Read the skill's SKILL.md content for fast-path content-drift detection.
 * Returns null when the file is missing or unreadable — callers treat null
 * as "unknown" and fall through to a full reinstall rather than asserting
 * equality on a missing fingerprint.
 */
function readSkillMd(dir: string): string | null {
  const skillPath = join(dir, "SKILL.md");
  if (!existsSync(skillPath)) return null;
  try {
    return readFileSync(skillPath, "utf8");
  } catch {
    return null;
  }
}

type SymlinkInspection =
  | { kind: "missing" }
  | { kind: "symlink"; target: string }
  | { kind: "directory" }
  | { kind: "file" };

function inspectPath(p: string): SymlinkInspection {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(p);
  } catch {
    return { kind: "missing" };
  }
  if (stat.isSymbolicLink()) return { kind: "symlink", target: readlinkSync(p) };
  if (stat.isDirectory()) return { kind: "directory" };
  return { kind: "file" };
}

function isWindowsSymlinkPermissionError(err: unknown): boolean {
  if (process.platform !== "win32") return false;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EACCES";
}

function isMatchingSkillDirectory(candidateDir: string, sourceDir: string): boolean {
  const candidateVersion = readVersionFile(candidateDir);
  const sourceVersion = readVersionFile(sourceDir);
  if (candidateVersion === null || sourceVersion === null || candidateVersion !== sourceVersion) return false;
  const candidateSkill = readSkillMd(candidateDir);
  const sourceSkill = readSkillMd(sourceDir);
  return candidateSkill !== null && sourceSkill !== null && candidateSkill === sourceSkill;
}

function isClaudeCompanionCurrent(workspacePath: string, layout: SkillLayout, agentsFull: string): boolean {
  const claudeFull = join(workspacePath, layout.claudeRelPath);
  const claudeState = inspectPath(claudeFull);
  if (claudeState.kind === "symlink" && claudeState.target === layout.claudeSymlinkTarget) return true;
  return claudeState.kind === "directory" && isMatchingSkillDirectory(claudeFull, agentsFull);
}

/**
 * Make `<workspacePath>/.claude/skills/<name>` a relative symlink to the
 * matching `.agents/skills/<name>` directory where symlink creation is
 * available. Windows hosts without symlink privileges fall back to a regular
 * directory copy so Claude Code still sees the shipped skill payload.
 *
 * Uses the same temp-path + rename atomic-swap pattern as
 * `ensureClaudeMdSymlink` in `bootstrap.ts` (PR #797 nit) so two
 * concurrent same-agent session starts cannot race the unlink/symlink
 * pair into an `EEXIST`. We materialise the new link at a unique
 * sibling path then `rename` it onto the target — POSIX makes that
 * atomic, and rename overwrites any existing file or symlink in place.
 * The temp file is cleaned up on any failure so a crashed write does
 * not leak siblings.
 *
 * Skips the swap entirely when the existing entry already points at
 * the correct target (the steady-state fast path on every session
 * start). Replaces anything else — a stale symlink, a clobbered
 * regular file, or even a stale fallback directory.
 */
function ensureClaudeSymlink(workspacePath: string, layout: SkillLayout, agentsFull: string): void {
  const claudeFull = join(workspacePath, layout.claudeRelPath);
  mkdirSync(dirname(claudeFull), { recursive: true });
  const existing = inspectPath(claudeFull);
  if (existing.kind === "symlink" && existing.target === layout.claudeSymlinkTarget) return;

  const tempPath = `${claudeFull}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    symlinkSync(layout.claudeSymlinkTarget, tempPath);
  } catch (err) {
    try {
      rmSync(tempPath, { force: true, recursive: true });
    } catch {
      // Best-effort cleanup — surface the original symlink failure unless
      // Windows can use the directory-copy fallback below.
    }
    if (!isWindowsSymlinkPermissionError(err)) throw err;
    ensureClaudeDirectoryCopy(workspacePath, layout, agentsFull);
    return;
  }
  try {
    // `renameSync` overwrites a regular file or symlink in place atomically
    // on POSIX; on a directory it returns ENOTDIR / EISDIR depending on
    // platform. Pre-remove the directory case explicitly so the atomic
    // swap below has a uniform target shape.
    if (existing.kind === "directory") {
      rmSync(claudeFull, { force: true, recursive: true });
    }
    renameSync(tempPath, claudeFull);
  } catch (err) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup — surface the original rename failure.
    }
    throw err;
  }
}

function ensureClaudeDirectoryCopy(workspacePath: string, layout: SkillLayout, agentsFull: string): void {
  const claudeFull = join(workspacePath, layout.claudeRelPath);
  mkdirSync(dirname(claudeFull), { recursive: true });
  if (inspectPath(claudeFull).kind === "directory" && isMatchingSkillDirectory(claudeFull, agentsFull)) return;

  const tempPath = `${claudeFull}.${randomBytes(6).toString("hex")}.tmp`;
  rmSync(tempPath, { force: true, recursive: true });
  try {
    cpSync(agentsFull, tempPath, { recursive: true });
    rmSync(claudeFull, { force: true, recursive: true });
    renameSync(tempPath, claudeFull);
  } catch (err) {
    try {
      rmSync(tempPath, { force: true, recursive: true });
    } catch {
      // Best-effort cleanup — surface the original copy/rename failure.
    }
    throw err;
  }
}

/**
 * Install one skill into `<workspacePath>/.agents/skills/<name>/` (real
 * directory copy) and ensure `<workspacePath>/.claude/skills/<name>`
 * exists as a relative symlink to it.
 *
 * Version gate: when the on-disk VERSION matches the bundled VERSION,
 * skip the copy + symlink-replace (fast path). Returns "installed",
 * "skipped", or throws on failure.
 *
 * @internal Exported for unit tests.
 */
export function installOneSkill(workspacePath: string, layout: SkillLayout): "installed" | "skipped" {
  if (!existsSync(layout.sourceDir) || !statSync(layout.sourceDir).isDirectory()) {
    throw new Error(`bundled skill source missing: ${layout.sourceDir}`);
  }

  const bundledVersion = readVersionFile(layout.sourceDir);
  const agentsFull = join(workspacePath, layout.agentsRelPath);
  const installedVersion = inspectPath(agentsFull).kind === "directory" ? readVersionFile(agentsFull) : null;

  // Fast path: same VERSION on both sides AND SKILL.md content matches
  // AND the Claude companion entry looks right. Comparing SKILL.md content as
  // well as VERSION is a defense-in-depth against the human-forgot-to-
  // bump-VERSION failure mode (PR #844 review — yuezengwu): without it,
  // a developer who edits SKILL.md but leaves VERSION at the previous
  // value would silently serve stale skills to every running agent. The
  // SKILL.md read is a few KB per skill per session start — negligible.
  // If only the Claude companion entry is wrong, fall through so we rewrite
  // it without a full re-copy.
  const fingerprintsAgree =
    bundledVersion !== null &&
    installedVersion !== null &&
    bundledVersion === installedVersion &&
    (() => {
      const bundledSkill = readSkillMd(layout.sourceDir);
      const installedSkill = readSkillMd(agentsFull);
      return bundledSkill !== null && installedSkill !== null && bundledSkill === installedSkill;
    })();
  if (fingerprintsAgree) {
    if (isClaudeCompanionCurrent(workspacePath, layout, agentsFull)) return "skipped";
    ensureClaudeSymlink(workspacePath, layout, agentsFull);
    return "skipped";
  }

  mkdirSync(dirname(agentsFull), { recursive: true });
  rmSync(agentsFull, { force: true, recursive: true });
  cpSync(layout.sourceDir, agentsFull, { recursive: true });
  ensureClaudeSymlink(workspacePath, layout, agentsFull);
  return "installed";
}

function installSkillSet(
  workspacePath: string,
  names: readonly string[],
  bundledSkillsRoot: string,
): InstallSkillsResult {
  const skipped: string[] = [];
  const installed: string[] = [];
  const failed: Array<{ name: string; reason: string }> = [];

  for (const name of names) {
    const layout = layoutFor(name, bundledSkillsRoot);
    try {
      const action = installOneSkill(workspacePath, layout);
      if (action === "skipped") skipped.push(name);
      else installed.push(name);
    } catch (err) {
      failed.push({ name, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    ok: failed.length === 0,
    skipped,
    installed,
    failed,
  };
}

export type InstallCoreSkillsOptions = {
  workspacePath: string;
  /** Override the bundled-skills lookup root for tests. */
  bundledSkillsRoot?: string;
};

export type InstallFirstTreeSkillsOptions = {
  workspacePath: string;
  /** Override the bundled-skills lookup root for tests. */
  bundledSkillsRoot?: string;
};

/**
 * Install the default First Tree skill payload family into the workspace.
 */
export function installCoreSkills(options: InstallCoreSkillsOptions): InstallSkillsResult {
  const bundledSkillsRoot = options.bundledSkillsRoot ?? resolveBundledSkillsRoot();
  reconcileCoreSkillState(options.workspacePath);
  return installSkillSet(options.workspacePath, CORE_SKILL_NAMES, bundledSkillsRoot);
}

/**
 * Reconcile the historical tree-skill ledger. Called by the agent bootstrap
 * when the agent has a Context Tree binding.
 *
 * Also reconciles `.agent/managed.json::skills`: any skill the workspace
 * recorded as installed by a previous CLI version but that's no longer in
 * `TREE_SKILL_NAMES` gets its `.agents/skills/<name>/` payload and
 * `.claude/skills/<name>` symlink removed. The current set is then written
 * back to state. The current tree-specific set is empty because all shipped
 * First Tree payloads install through the default family.
 */
export function installFirstTreeSkills(options: InstallFirstTreeSkillsOptions): InstallSkillsResult {
  const bundledSkillsRoot = options.bundledSkillsRoot ?? resolveBundledSkillsRoot();
  const result = installSkillSet(options.workspacePath, TREE_SKILL_NAMES, bundledSkillsRoot);
  reconcileTreeSkillState(options.workspacePath);
  return result;
}

function reconcileCoreSkillState(workspacePath: string): void {
  for (const retiredSkill of RETIRED_CORE_SKILL_NAMES) {
    removeManagedSkill(workspacePath, retiredSkill);
  }
}

/**
 * Compare the previously-managed skill set against the current
 * `TREE_SKILL_NAMES` and remove any skill no longer in the current bundle.
 * Per-skill cleanup is best-effort: a missing payload is a noop, and a
 * raised exception on remove is logged-via-throw nowhere — callers never
 * see it, so we swallow internally to avoid blocking the agent start over a
 * stale-skill removal failure.
 *
 * State is persisted regardless of per-skill outcome so a future install
 * pass diffs against today's reality.
 */
function reconcileTreeSkillState(workspacePath: string): void {
  // Never remove a skill that either tier currently ships. Skills have moved
  // between CORE and TREE across releases, and a bound workspace may already
  // have the payload on disk from the other installer path. Protect both
  // current sets; removal is only for names that left BOTH lists (genuinely
  // retired skills).
  const protectedSkills = new Set<string>([...TREE_SKILL_NAMES, ...CORE_SKILL_NAMES]);
  const prev = readManagedState(workspacePath);
  if (prev) {
    for (const prevSkill of prev.skills) {
      if (protectedSkills.has(prevSkill)) continue;
      removeManagedSkill(workspacePath, prevSkill);
    }
  }
  // Managed state records only the TREE set: it is the reconcile ledger for
  // this install path. Today that set is empty because all shipped First Tree
  // skills install through CORE. CORE skills are cleaned up via
  // `RETIRED_CORE_SKILL_NAMES` in `reconcileCoreSkillState`, not by diffing
  // this ledger, so recording them here would double-count their lifecycle.
  updateManagedState(workspacePath, resolveBundledCliVersion(), (current) => ({
    ...current,
    skills: [...TREE_SKILL_NAMES].sort(),
  }));
}

/**
 * Remove a previously-managed skill's on-disk payload AND its Claude Code
 * companion entry. Either step is best-effort and only operates on entries that
 * actually exist; anything the user added later (a custom skill payload
 * under `.agents/skills/<user-skill>/`) is never touched because we look
 * up by NAME, not by listing the directory.
 */
function removeManagedSkill(workspacePath: string, name: string): void {
  const agentsFull = join(workspacePath, ".agents", "skills", name);
  const claudeFull = join(workspacePath, ".claude", "skills", name);
  try {
    rmSync(agentsFull, { recursive: true, force: true });
  } catch {
    // Best-effort — the Claude companion cleanup below still runs.
  }
  try {
    const claudeState = inspectPath(claudeFull);
    if (claudeState.kind === "missing") return;
    if (claudeState.kind === "directory") {
      rmSync(claudeFull, { recursive: true, force: true });
    } else {
      unlinkSync(claudeFull);
    }
  } catch {
    // Either missing or remove failed — both acceptable here.
  }
}
