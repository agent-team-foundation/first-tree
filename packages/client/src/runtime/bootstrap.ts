import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contextTreeActiveBindingSchema } from "@first-tree/shared";
import type { FirstTreeHubSDK } from "../sdk.js";
import { getCliBinding } from "./cli-binding.js";
import { installCoreSkills as installCoreSkillsImpl, installFirstTreeSkills } from "./first-tree-skills/installer.js";
import type { AgentIdentity } from "./handler.js";
import { CONTEXT_TREE_DIRNAME } from "./workspace-manifest.js";

/**
 * Resolved Context Tree binding the runtime threads through every layer:
 * the agent-local checkout path AND the upstream coordinates.
 *
 * Per the agent-managed-repos design the runtime performs **no git
 * operations** on this path — the agent itself clones and refreshes
 * `<agentHome>/context-tree` following the protocol injected into its
 * briefing (clone-if-missing; `git pull --ff-only` before every tree
 * read). The runtime only *names* the path (briefing, workspace manifest,
 * identity.json) and *observes* it read-only (`git rev-parse` HEAD-drift
 * detection in `agent-bootstrap.ts`). The upstream URL and branch are
 * surfaced in the briefing so the agent knows what to clone.
 */
export type ContextTreeBinding = {
  path: string;
  repoUrl: string;
  branch: string;
};

/**
 * Resolve the Context Tree binding for the authenticated runtime agent —
 * pure configuration resolution, no filesystem or git side effects.
 *
 * Uses the SDK's agent-scoped `/api/v1/agent/context-tree/info` route, so
 * the binding follows the agent's own organization rather than the
 * caller's default organization. The local path is fixed at
 * `<workspaceRoot>/context-tree`: the agent maintains its own clone there
 * (one clone per agent home — the shared `<dataDir>/context-tree-repos/`
 * pool is retired; existing pool checkouts are left on disk untouched for
 * the operator to clean up, and a legacy `context-tree` symlink into the
 * pool keeps working for reads until the agent replaces it per its
 * briefing protocol).
 *
 * Returns `null` when no tree is configured or the server is unreachable
 * (graceful degradation — the agent starts tree-less).
 */
export async function resolveAgentContextTreeBinding(
  sdk: FirstTreeHubSDK,
  workspaceRoot: string,
  log: (msg: string) => void,
): Promise<ContextTreeBinding | null> {
  try {
    const config: unknown = await sdk.getAgentContextTreeConfig();
    if (
      typeof config === "object" &&
      config !== null &&
      "repo" in config &&
      (config.repo === null || config.repo === undefined)
    ) {
      log("Context Tree binding skipped: not configured on server");
      return null;
    }

    const binding = contextTreeActiveBindingSchema.safeParse(config);
    if (!binding.success) {
      log("Context Tree binding skipped: server returned an invalid binding");
      return null;
    }

    return {
      path: join(workspaceRoot, CONTEXT_TREE_DIRNAME),
      repoUrl: binding.data.repo,
      branch: binding.data.branch,
    };
  } catch {
    log("Context Tree binding skipped: failed to fetch config from server");
    return null;
  }
}

/**
 * Marker directory written into every workspace so the Codex CLI's
 * project-root detection (configured via
 * `project_root_markers: [".first-tree-workspace"]`) stops at the workspace
 * boundary instead of walking up the filesystem and loading an unintended
 * `AGENTS.md` from the operator's home or repo root.
 */
export const FIRST_TREE_WORKSPACE_MARKER = ".first-tree-workspace";
export const FIRST_TREE_RUNTIME_DIR = FIRST_TREE_WORKSPACE_MARKER;
export const LEGACY_AGENT_RUNTIME_DIR = ".agent";
export const IDENTITY_JSON_REL = join(FIRST_TREE_RUNTIME_DIR, "identity.json");

/**
 * Materialise the unified agent briefing at `<workspacePath>/AGENTS.md` and
 * keep `<workspacePath>/CLAUDE.md` as a relative symlink to it where the host
 * permits symlink creation. Windows hosts without symlink privileges fall back
 * to a regular `CLAUDE.md` copy so Claude Code can still read the briefing.
 *
 * One file, both providers: Codex's `project_root_markers` walk finds
 * `AGENTS.md` directly; Claude Code's `settingSources: ["project"]` follows
 * the `CLAUDE.md` symlink. Edits to the briefing layout only need to land in
 * the {@link buildAgentBriefing} producer.
 */
export function writeAgentBriefing(workspacePath: string, content: string): void {
  writeFileSync(join(workspacePath, "AGENTS.md"), content, "utf-8");
  ensureClaudeMdSymlink(workspacePath, content);
}

/**
 * Make `<workspacePath>/CLAUDE.md` a relative symlink to `AGENTS.md` where
 * possible. Replaces a stale regular file or broken/mis-targeted symlink left
 * from earlier bootstrap formats; a no-op when the symlink is already correct.
 * On Windows symlink permission failures (`EPERM` / `EACCES`), falls back to a
 * regular file copy carrying the same briefing content.
 *
 * Atomically swaps in the new symlink via `rename` so two concurrent
 * same-agent starts can't race the unlink/symlink pair into an `EEXIST`
 * (PR #797 review nit #3). We materialise the new link at a unique
 * sibling path, then `rename` it onto `CLAUDE.md` — POSIX makes that
 * atomic, and the rename overwrites any existing file or symlink in place.
 * The temp file is cleaned up on any failure so a crashed write does not
 * leak siblings.
 *
 * ⚠️ SDK assumption (regression-watch on `@anthropic-ai/claude-agent-sdk`
 * version bumps): this layout relies on the Claude Code SDK enumerating
 * ONLY `<cwd>/CLAUDE.md` as a Project memory file — the SDK does not look
 * for `<cwd>/AGENTS.md` separately, so the symlink is resolved
 * transparently with no double-load. Verified on 0.2.84 (`grep -c
 * '"AGENTS.md"' cli.js` → 0; `grep -c '"CLAUDE.md"' cli.js` → 13, all on
 * Project / User / Local / Managed memory paths). If a future SDK adds
 * AGENTS.md as a sibling Project memory entry, the briefing would
 * double-load — re-run the manual probes documented in tree-context PR
 * #397 before upgrading the SDK major version.
 */
export function ensureClaudeMdSymlink(workspacePath: string, fallbackContent?: string): void {
  const claudeMd = join(workspacePath, "CLAUDE.md");
  const targetRel = "AGENTS.md";
  try {
    const stats = lstatSync(claudeMd);
    if (stats.isSymbolicLink() && readlinkSync(claudeMd) === targetRel) return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const tempPath = join(workspacePath, `.CLAUDE.md.${randomBytes(6).toString("hex")}.tmp`);
  try {
    symlinkSync(targetRel, tempPath);
  } catch (err) {
    try {
      rmSync(tempPath, { force: true, recursive: true });
    } catch {
      // Best-effort cleanup — surface the original symlink failure unless
      // Windows can use the regular-file fallback below.
    }
    if (!isWindowsSymlinkPermissionError(err)) throw err;
    writeClaudeMdFallbackFile(workspacePath, fallbackContent);
    return;
  }
  try {
    renameSync(tempPath, claudeMd);
  } catch (err) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup — surface the original rename failure.
    }
    throw err;
  }
}

function writeClaudeMdFallbackFile(workspacePath: string, content?: string): void {
  const claudeMd = join(workspacePath, "CLAUDE.md");
  const nextContent = content ?? readFileSync(join(workspacePath, "AGENTS.md"), "utf8");
  const tempPath = join(workspacePath, `.CLAUDE.md.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tempPath, nextContent, "utf-8");
  try {
    renameSync(tempPath, claudeMd);
  } catch (err) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup — surface the original rename failure.
    }
    throw err;
  }
}

function isWindowsSymlinkPermissionError(err: unknown): boolean {
  if (process.platform !== "win32") return false;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EACCES";
}

/**
 * Per-agent-home pin file for the CLI version that performed the last
 * bootstrap. The bundled skills payload ships with the CLI binary, so this
 * version is the content drift key: when the operator upgrades the CLI, the
 * next session re-runs the slow bootstrap and refreshes
 * `.agents/skills/*`. Without this trigger, agent homes would silently
 * keep stale skill payloads after an upgrade.
 */
export const BUNDLED_CLI_VERSION_REL = join(FIRST_TREE_RUNTIME_DIR, "cli-version");

/**
 * Resolve a stable identifier for the bundled CLI that the handler can
 * compare against the cached `.first-tree-workspace/cli-version` to detect
 * upgrades.
 *
 * Behaviour by channel:
 *
 *   - **prod / staging** — returns the bare `<pkgVersion>` from the
 *     closest ancestor `package.json`. CI bumps that manifest's `version`
 *     on every release, so version alone is the unique build identifier.
 *   - **dev** — returns `<pkgVersion>+build.<mtime>`, where `<mtime>` is
 *     the integer `mtimeMs` of the file backing `moduleUrl`. Dev iteration
 *     never bumps `apps/cli/package.json` (CLAUDE.md forbids touching
 *     `version` fields), so a bare version would be constant across every
 *     `scripts/dev-install.sh` cycle and `cliDrifted` would never fire.
 *     `pnpm build` rewrites `dist/cli/index.mjs` and updates its mtime,
 *     so the appended suffix changes on every build → handler triggers
 *     a full re-bootstrap and the agent home picks up the new
 *     AGENTS.md briefing and shipped skills payload.
 *
 * Channel is read from `getCliBinding().packageName`: `null` is the dev
 * channel (dev binaries are not published — see
 * `runtime/cli-binding.ts`), everything else is a published channel.
 *
 * If `getCliBinding()` has not been initialised yet (e.g. an early
 * bootstrap call before `apps/cli` wired the binding), we fall through
 * to the bare-version path so the caller still gets something
 * drift-comparable.
 *
 * Walk source: the closest ancestor `package.json` with a non-empty
 * `version`. For the **published bundle**, `bootstrap.ts` is inlined
 * into `apps/cli/dist/<chunk>.mjs`, so the walk lands on the CLI
 * manifest. For **source-tree `tsx` / vitest runs** it lands on the
 * private `@first-tree/client` manifest — that version is constant in
 * dev too, which is exactly why dev needs the mtime suffix.
 *
 * Imported from here (not from `apps/cli`) to keep the client → CLI
 * dependency direction one-way.
 *
 * Returns `null` only when the walk exhausts every parent without
 * finding any `version` — drift detection then falls back to "unknown",
 * never to "drifted".
 */
export function resolveBundledCliVersion(moduleUrl: string = import.meta.url): string | null {
  let dir = dirname(fileURLToPath(moduleUrl));
  let version: string | null = null;
  for (let i = 0; i < 10; i += 1) {
    const candidate = resolve(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
        if (typeof parsed.version === "string" && parsed.version.length > 0) {
          version = parsed.version;
          break;
        }
      } catch {
        // Corrupt or unreadable — keep walking; finding *some* version is
        // better than crashing the bootstrap path.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (version === null) return null;

  // Channel gate: only the dev channel needs the build fingerprint.
  // packageName === null is the published-channel-absent marker (see
  // CliBinding's docblock). Anywhere else (prod / staging / uninitialised)
  // we keep the bare version — staging/prod have a release-bumped
  // version that already changes per build, so a fingerprint would just
  // be noise in the `.first-tree-workspace/cli-version` pin.
  let isDevChannel = false;
  try {
    isDevChannel = getCliBinding().packageName === null;
  } catch {
    // Binding not initialised — treat as non-dev. Safer default: skip
    // the suffix rather than emit a fingerprint into a sentinel that a
    // later boot (with binding set) would reject as drifted.
  }
  if (!isDevChannel) return version;

  // Wrapped in try/catch so a synthetic `moduleUrl` pointing at a
  // non-existent path still produces a usable version string for callers
  // (and tests) that hand in dummy URLs.
  try {
    const mtimeMs = Math.floor(statSync(fileURLToPath(moduleUrl)).mtimeMs);
    return `${version}+build.${mtimeMs}`;
  } catch {
    return version;
  }
}

/** Read the cached CLI version that last ran bootstrap, if any. */
export function readCachedBundledCliVersion(workspacePath: string): string | null {
  const path = join(workspacePath, BUNDLED_CLI_VERSION_REL);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

/** Persist the bundled CLI version alongside the sentinel. */
export function writeBundledCliVersion(workspacePath: string, version: string | null): void {
  if (!version) return;
  const path = join(workspacePath, BUNDLED_CLI_VERSION_REL);
  ensureWorkspaceRuntimeDir(workspacePath);
  writeFileSync(path, version, "utf-8");
}

function lstatIfExists(path: string) {
  try {
    return lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Merge legacy `.agent/` entries into `.first-tree-workspace/`.
 *
 * Conflict policy is intentionally "target wins": if a path already exists in
 * the target, the legacy source entry at that path is pruned instead of
 * overwriting newer runtime state. That keeps partial upgrades and repeated
 * bootstraps idempotent.
 */
function mergeLegacyRuntimeDir(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir)) {
    const sourcePath = join(sourceDir, entry);
    const targetPath = join(targetDir, entry);
    const sourceStats = lstatSync(sourcePath);
    if (sourceStats.isDirectory()) {
      if (existsSync(targetPath) && lstatSync(targetPath).isDirectory()) {
        mergeLegacyRuntimeDir(sourcePath, targetPath);
      } else if (!existsSync(targetPath)) {
        renameSync(sourcePath, targetPath);
      } else {
        rmSync(sourcePath, { recursive: true, force: true });
      }
      continue;
    }
    if (!existsSync(targetPath)) {
      renameSync(sourcePath, targetPath);
    } else {
      rmSync(sourcePath, { recursive: true, force: true });
    }
  }
  rmSync(sourceDir, { recursive: true, force: true });
}

/**
 * Converge the runtime state onto the current `.first-tree-workspace/` layout.
 *
 * Legacy states we still heal automatically:
 *
 * - root marker file `.first-tree-workspace` from the pre-directory layout
 * - stable runtime dir `.agent/` from the pre-rename layout
 *
 * The resulting directory both stores the stable runtime files and acts as the
 * root marker Codex uses for project detection.
 *
 * Note: apps/cli still has a separate W1 migration path that reasons about a
 * legacy file marker named `.first-tree-workspace` inside user workspaces.
 * This helper only heals the per-agent runtime home under
 * `<dataDir>/workspaces/<agent>/`, so replacing a pre-existing file or symlink
 * here does not participate in CLI workspace detection.
 */
export function ensureWorkspaceRuntimeDir(workspacePath: string): string {
  const runtimeDir = join(workspacePath, FIRST_TREE_RUNTIME_DIR);
  const legacyAgentDir = join(workspacePath, LEGACY_AGENT_RUNTIME_DIR);
  const runtimeStats = lstatIfExists(runtimeDir);

  if (runtimeStats && !runtimeStats.isDirectory()) {
    unlinkSync(runtimeDir);
  }

  const legacyAgentStats = lstatIfExists(legacyAgentDir);
  const currentRuntimeStats = lstatIfExists(runtimeDir);
  if (legacyAgentStats?.isDirectory()) {
    if (currentRuntimeStats?.isDirectory()) {
      mergeLegacyRuntimeDir(legacyAgentDir, runtimeDir);
    } else if (!currentRuntimeStats) {
      renameSync(legacyAgentDir, runtimeDir);
    }
  }

  mkdirSync(runtimeDir, { recursive: true });
  return runtimeDir;
}

/**
 * Apply the legacy runtime-layout migration without rewriting identity or any
 * other bootstrap-managed files. Shared by handler bootstrap and the client
 * startup migration so both converge on the same cleanup: move `.agent/`
 * into `.first-tree-workspace/`, then prune legacy `.agent/context/` and
 * `.agent/tools.md` payloads that the unified briefing replaced.
 */
export function migrateLegacyRuntimeLayout(workspacePath: string): string {
  const runtimeDir = ensureWorkspaceRuntimeDir(workspacePath);
  const legacyContextDir = join(runtimeDir, "context");
  if (existsSync(legacyContextDir)) {
    rmSync(legacyContextDir, { recursive: true, force: true });
  }
  const legacyToolsMd = join(runtimeDir, "tools.md");
  if (existsSync(legacyToolsMd)) {
    rmSync(legacyToolsMd, { force: true });
  }
  return runtimeDir;
}

export type BootstrapOptions = {
  workspacePath: string;
  identity: AgentIdentity;
  contextTreePath: string | null;
  serverUrl: string;
};

/**
 * Bootstrap the agent's home directory with stable, agent-level files inside
 * the workspace-root marker directory.
 *
 * Writes identity.json into `.first-tree-workspace/`. Per the
 * agent-session-cwd-redesign (proposals/2026-05-19) **only agent-level stable
 * fields** live in identity.json; per-chat data (chatId, participants) flows
 * through provider/session prompt injection, not through identity.json or the
 * shared briefing written by {@link writeAgentBriefing}.
 *
 * The bootstrap no longer stages AGENT.md / NODE.md copies under the legacy
 * `.agent/context/` tree and no longer emits `.agent/tools.md`. The unified
 * briefing owns all of that content; the runtime briefing is the single source
 * of agent-level instructions on disk.
 *
 * Idempotent: safe to call on every handler start() / resume(), though in
 * the per-agent-home model the handler short-circuits this when the
 * `.first-tree-workspace/init-complete` sentinel is already present.
 */
export function bootstrapWorkspace(options: BootstrapOptions): void {
  const { workspacePath, identity, contextTreePath, serverUrl } = options;
  const agentDir = migrateLegacyRuntimeLayout(workspacePath);

  // 1. Write identity.json — agent-level stable fields only. chatId /
  //    chatContext used to live here but are now injected per turn so a
  //    different chat resuming this same cwd doesn't see another chat's
  //    cached participants.
  const identityData = {
    agentId: identity.agentId,
    displayName: identity.displayName,
    type: identity.type,
    visibility: identity.visibility,
    delegateMention: identity.delegateMention,
    metadata: identity.metadata,
    serverUrl,
    contextTreePath,
  };
  writeFileSync(join(agentDir, "identity.json"), JSON.stringify(identityData, null, 2), "utf-8");
}

export type InstallFirstTreeIntegrationOptions = {
  workspacePath: string;
  log: (msg: string) => void;
  /**
   * Override the bundled-skills lookup root. Tests use this to point at a
   * fixture skills/ directory; production leaves it undefined and the
   * installer walks up from its own module URL to the @first-tree/client
   * package root.
   */
  bundledSkillsRoot?: string;
};

export type InstallCoreSkillsOptions = {
  workspacePath: string;
  log: (msg: string) => void;
  /** See {@link InstallFirstTreeIntegrationOptions.bundledSkillsRoot}. */
  bundledSkillsRoot?: string;
};

/**
 * Reconcile the historical tree-skill ledger for a tree-bound workspace.
 *
 * The current `TREE_SKILL_NAMES` set is empty because the default First Tree
 * skill family installs through `installCoreSkills`. This path remains as the
 * managed-state cleanup hook for names previous versions recorded as
 * tree-scoped skills; it removes genuinely retired entries and records the
 * current empty ledger.
 *
 * Returns `false` when reconciliation fails; caller logs the failure and
 * continues. The agent session still starts.
 *
 * Pre-2026-06 history: this used to shell out to `<binName> tree skill
 * install --root <workspacePath>`. The CLI dependency was removed when
 * the @first-tree/client package started bundling skill payloads
 * directly (see `scripts/copy-bundled-skills.mjs`). No more `npx -y
 * `first-tree@latest` cold-download on first run, no more `binName` PATH
 * resolution, no more channel-aware fallback dance.
 */
export function installFirstTreeIntegration(options: InstallFirstTreeIntegrationOptions): boolean {
  const { workspacePath, log, bundledSkillsRoot } = options;
  try {
    const result = installFirstTreeSkills({ workspacePath, bundledSkillsRoot });
    const parts: string[] = [];
    if (result.installed.length > 0) parts.push(`installed ${result.installed.join(", ")}`);
    if (result.skipped.length > 0) parts.push(`up-to-date ${result.skipped.join(", ")}`);
    if (result.failed.length > 0) parts.push(`failed ${result.failed.map((f) => f.name).join(", ")}`);
    log(`First-tree skills: ${parts.join("; ") || "no skills configured"}`);
    for (const f of result.failed) {
      log(`First-tree skill install failed (${f.name}): ${f.reason.slice(0, 200)}`);
    }
    return result.ok;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`First-tree skills install skipped: ${msg.slice(0, 200)}`);
    return false;
  }
}

/**
 * Install the default First Tree skill payload family. The function name keeps
 * the old "core" API surface, but the installed set is now the full small
 * family: welcome, seed, bug reporting, read, and write.
 */
export function installCoreSkills(options: InstallCoreSkillsOptions): boolean {
  const { workspacePath, log, bundledSkillsRoot } = options;
  try {
    const result = installCoreSkillsImpl({ workspacePath, bundledSkillsRoot });
    if (result.installed.length > 0 || result.skipped.length > 0 || result.failed.length > 0) {
      const parts: string[] = [];
      if (result.installed.length > 0) parts.push(`installed ${result.installed.join(", ")}`);
      if (result.skipped.length > 0) parts.push(`up-to-date ${result.skipped.join(", ")}`);
      if (result.failed.length > 0) parts.push(`failed ${result.failed.map((f) => f.name).join(", ")}`);
      log(`First-tree skills: ${parts.join("; ")}`);
    }
    for (const f of result.failed) {
      log(`First-tree skill install failed (${f.name}): ${f.reason.slice(0, 200)}`);
    }
    return result.ok;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`First-tree skill install skipped: ${msg.slice(0, 200)}`);
    return false;
  }
}

/**
 * One predeclared source repository the agent config declares under the agent
 * home's `source-repos/` directory (e.g. `<agentHome>/source-repos/<localPath>/`).
 * Pure declaration — the agent itself clones/refreshes it per its briefing
 * protocol (the runtime never runs git on it). Surfaced in the per-chat system
 * prompt so the LLM knows the absolute path and upstream coordinates.
 *
 * Note: the old "PredeclaredWorktree" model put these under
 * `<agentHome>/worktrees/<name>/`. Source clones now sit under `source-repos/`
 * so the `worktrees/` subdir is reserved **entirely** for agent-on-demand
 * worktrees the LLM creates per task.
 */
export type PredeclaredSourceRepo = {
  /** Absolute path on the host filesystem (under the agent home's `source-repos/` dir). */
  absolutePath: string;
  url: string;
  ref?: string;
  branch?: string;
};

/**
 * Field-by-field equality for the identity record both handlers write into
 * `.first-tree-workspace/identity.json`. Implemented manually so a missing
 * key on disk from an older bootstrap is treated as drift even when
 * `JSON.stringify` happens to match by chance.
 *
 * Shared between claude-code and codex handlers — both call
 * `ensureStableIdentity` / `ensureCodexBootstrap` to hash-check before
 * skipping the bootstrap rewrite.
 */
export function deepEqualIdentity(a: unknown, b: unknown): boolean {
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return a === b;
  const aRec = a as Record<string, unknown>;
  const bRec = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(aRec), ...Object.keys(bRec)]);
  for (const k of keys) {
    const av = aRec[k];
    const bv = bRec[k];
    if (typeof av === "object" && typeof bv === "object") {
      if (JSON.stringify(av) !== JSON.stringify(bv)) return false;
    } else if (av !== bv) {
      return false;
    }
  }
  return true;
}
