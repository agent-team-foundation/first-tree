import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
import { promisify } from "node:util";
import { defaultDataDir } from "@first-tree/shared/config";
import type { ContextTreeConfig } from "../sdk.js";
import { type AccessTokenProvider, FirstTreeHubSDK } from "../sdk.js";
import { getCliBinding } from "./cli-binding.js";
import { installCoreSkills as installCoreSkillsImpl, installFirstTreeSkills } from "./first-tree-skills/installer.js";
import { httpsToSshBaseRewrite } from "./git-mirror-manager.js";
import type { AgentIdentity } from "./handler.js";

/**
 * Promisified `execFile` used by the Context Tree sync path. The sync path
 * runs at startup while N agents are concurrently issuing `agent:bind` and
 * `/api/v1/agent/config` requests; `execFileSync` froze the event loop for the
 * full duration of `git pull` (~7s on a typical home connection), which made
 * `AbortSignal.timeout(5_000)` on those in-flight HTTP calls fire spuriously —
 * server-side traces showed the requests completing in <10ms — and stretched
 * boot to ≈7s × N because each blocking pull also stalled the dedup window in
 * {@link withContextTreeSyncLock}: only the very first slot to reach the lock
 * collapsed onto the leader's promise, every later slot arrived after the
 * leader's pull had already resolved and acquired a fresh lock of its own.
 * Async exec lets the event loop keep servicing HTTP responses, lets all N
 * slots reach the lock during the leader's pull, and collapses startup to a
 * single shared sync (~10s total instead of ~7s × N).
 */
const execFileAsync = promisify(execFile);

/**
 * `execFile` defaults `maxBuffer` to 1MB; once child output exceeds that it
 * rejects with `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` and the whole sync path
 * falls through. `git clone` of a small Context Tree is typically harmless,
 * but the verbose / progress lines of an unusually large or slow clone (or a
 * future debug flag) can creep past the default. Reserve 10MB on the three
 * clone call sites — cheap defence against a rare but high-blast-radius
 * failure mode, since hitting it cascades into the SSH-fallback and
 * re-clone branches and finally leaves the agent with no Context Tree.
 */
const GIT_CLONE_MAX_BUFFER = 10 * 1024 * 1024;

// Function rather than top-level const: see CLI's `channel-env.ts`
// history note — locking a path at module load re-introduces the bundle
// eval-order foot-gun the resolver function-ization fixed.
function contextTreeReposDir(): string {
  return join(defaultDataDir(), "context-tree-repos");
}

const contextTreeSyncLocks = new Map<string, Promise<ContextTreeBinding | null>>();

/**
 * Resolved Context Tree binding the runtime threads through every layer:
 * the local checkout path AND the upstream coordinates. The URL is
 * surfaced in the agent briefing so the LLM can reference the upstream
 * repo when describing the tree to humans, even though Client-side
 * read-only sync only needs the local path.
 */
export type ContextTreeBinding = {
  path: string;
  repoUrl: string;
  branch: string;
};

export function contextTreeCloneDir(repo: string, branch: string): string {
  const digest = createHash("sha256").update(`${repo}\0${branch}`).digest("hex");
  return join(contextTreeReposDir(), digest);
}

/**
 * Convert a plain HTTPS git URL to its scp-like SSH counterpart for fallback
 * cloning. Delegates the host parsing + safety rules (reject embedded
 * credentials, reject non-default ports) to `httpsToSshBaseRewrite` in
 * git-mirror-manager — keeps a single source of truth for URL rewriting.
 * Returns null when no portable mapping exists.
 */
function toSshGitUrl(httpsRepo: string): string | null {
  const rewrite = httpsToSshBaseRewrite(httpsRepo);
  if (!rewrite) return null;
  // `rewrite.httpsBase` is the `https://<host>/` prefix; replace it with the
  // matching `git@<host>:` to produce a full SSH URL for the same path.
  if (!httpsRepo.startsWith(rewrite.httpsBase)) return null;
  return rewrite.sshBase + httpsRepo.slice(rewrite.httpsBase.length);
}

/**
 * De-dup concurrent Context Tree syncs for the same clone dir: when an
 * in-flight sync exists for `key`, share its settled result instead of
 * queueing another `git pull` round-trip. Once the in-flight promise
 * settles, the slot is cleared — subsequent calls trigger a fresh sync.
 *
 * The old implementation chained callers (`prev.then(fn)`), so N agents
 * sharing one Context Tree (the common case) cost N×git-pull at startup
 * — observed as ~7s per extra agent. With dedup, those N calls collapse
 * to a single shared sync. Each server `agent:bind` still resyncs the tree
 * once per process restart (the first caller's pull), which is the
 * contract `syncAgentContextTree` advertises.
 *
 * Exported for direct unit-testing; not re-exported from `src/index.ts`.
 */
export function withContextTreeSyncLock(
  key: string,
  fn: () => Promise<ContextTreeBinding | null>,
): Promise<ContextTreeBinding | null> {
  const inFlight = contextTreeSyncLocks.get(key);
  if (inFlight) return inFlight;
  const next = fn().finally(() => {
    if (contextTreeSyncLocks.get(key) === next) {
      contextTreeSyncLocks.delete(key);
    }
  });
  contextTreeSyncLocks.set(key, next);
  return next;
}

async function resolveContextTreeBinding(
  fetchConfig: () => Promise<ContextTreeConfig>,
  log: (msg: string) => void,
): Promise<ContextTreeBinding | null> {
  // 1. Check git is available
  try {
    await execFileAsync("git", ["--version"]);
  } catch {
    log("Context Tree sync skipped: git is not installed");
    return null;
  }

  // 2. Fetch repo config from server
  let repo: string;
  let branch: string;
  try {
    const config = await fetchConfig();
    if (!config.repo) {
      log("Context Tree sync skipped: not configured on server");
      return null;
    }
    repo = config.repo;
    branch = config.branch ?? "main";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Context Tree sync skipped: failed to fetch config from server (${msg})`);
    return null;
  }

  const cloneDir = contextTreeCloneDir(repo, branch);
  return withContextTreeSyncLock(cloneDir, () => syncContextTreeRepo(repo, branch, cloneDir, log));
}

async function syncContextTreeRepo(
  repo: string,
  branch: string,
  cloneDir: string,
  log: (msg: string) => void,
): Promise<ContextTreeBinding | null> {
  // 3. Clone or pull
  try {
    if (existsSync(join(cloneDir, ".git"))) {
      // Ensure we're on the expected branch before pulling
      const { stdout: headRef } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: cloneDir,
        encoding: "utf-8",
        timeout: 5_000,
      });
      if (headRef.trim() !== branch) {
        await execFileAsync("git", ["checkout", branch], {
          cwd: cloneDir,
          timeout: 10_000,
        });
        log(`Context Tree switched to branch ${branch}`);
      }

      // Pull latest changes
      await execFileAsync("git", ["pull", "--ff-only"], {
        cwd: cloneDir,
        timeout: 30_000,
      });
      log(`Context Tree updated (pull)`);
    } else {
      // First clone
      mkdirSync(cloneDir, { recursive: true });
      await execFileAsync("git", ["clone", "--branch", branch, "--single-branch", repo, cloneDir], {
        timeout: 60_000,
        maxBuffer: GIT_CLONE_MAX_BUFFER,
      });
      log(`Context Tree cloned from ${repo} (branch: ${branch})`);
    }
    return { path: cloneDir, repoUrl: repo, branch };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Context Tree sync failed: ${msg}`);
    log("Check that git credentials (SSH key or credential helper) are configured for this repo");

    // First-time HTTPS clone is the common failure case in headless service
    // envs (systemd / launchd) — no TTY for git's credential prompt, so HTTPS
    // auth exits with "could not read Username". If the configured URL is
    // HTTPS, retry once with the SSH counterpart before giving up. Many
    // operators have SSH keys configured even when credential helpers aren't.
    // Pull failures (existing .git present) skip this — the existing remote
    // is whatever clone last succeeded; switching it mid-flight is messier
    // than letting the "use existing clone" fallback below take over.
    const sshRepo = !existsSync(join(cloneDir, ".git")) ? toSshGitUrl(repo) : null;
    if (sshRepo) {
      log(`Retrying Context Tree clone via SSH: ${sshRepo}`);
      try {
        rmSync(cloneDir, { recursive: true, force: true });
        mkdirSync(cloneDir, { recursive: true });
        await execFileAsync("git", ["clone", "--branch", branch, "--single-branch", sshRepo, cloneDir], {
          timeout: 60_000,
          maxBuffer: GIT_CLONE_MAX_BUFFER,
        });
        log("Context Tree cloned via SSH fallback");
        // Report the SSH URL as ground truth — `git remote get-url origin`
        // on this checkout will be the SSH form, and downstream consumers
        // (telemetry, future tree wiring) should match the actual remote
        // rather than the configured-but-unusable HTTPS.
        return { path: cloneDir, repoUrl: sshRepo, branch };
      } catch (sshErr) {
        const sshMsg = sshErr instanceof Error ? sshErr.message : String(sshErr);
        log(`Context Tree SSH fallback also failed: ${sshMsg}`);
      }
    }

    // If pull failed due to diverged history, try re-clone.
    // Only re-clone when the error indicates a non-recoverable git state.
    // For transient errors (network, auth), preserve existing clone.
    const isGitStateError =
      msg.includes("cannot fast-forward") || msg.includes("not possible to fast-forward") || msg.includes("CONFLICT");

    if (isGitStateError && existsSync(join(cloneDir, ".git"))) {
      log("Diverged history detected, attempting fresh clone...");
      try {
        rmSync(cloneDir, { recursive: true, force: true });
        mkdirSync(cloneDir, { recursive: true });
        await execFileAsync("git", ["clone", "--branch", branch, "--single-branch", repo, cloneDir], {
          timeout: 60_000,
          maxBuffer: GIT_CLONE_MAX_BUFFER,
        });
        log("Context Tree re-cloned successfully");
        return { path: cloneDir, repoUrl: repo, branch };
      } catch {
        log("Context Tree re-clone also failed, continuing without context");
      }
    }

    // Return existing clone path if available (preserves local work on transient errors)
    if (existsSync(join(cloneDir, ".git"))) {
      log("Using existing Context Tree clone despite sync failure");
      return { path: cloneDir, repoUrl: repo, branch };
    }

    return null;
  }
}

/**
 * Sync the user-scoped Context Tree checkout.
 *
 * Fetches the legacy `/api/v1/context-tree/info` binding, which resolves
 * against the caller's current default organization. Clones on first run,
 * pulls on subsequent runs, using a hashed local checkout per `(repo, branch)`.
 * Returns the binding on success, null on failure (graceful degradation).
 */
export async function syncContextTree(
  serverUrl: string,
  getAccessToken: AccessTokenProvider,
  log: (msg: string) => void,
  userAgent?: string,
): Promise<ContextTreeBinding | null> {
  const sdk = new FirstTreeHubSDK({ serverUrl, getAccessToken, userAgent });
  return resolveContextTreeBinding(() => sdk.getContextTreeConfig(), log);
}

/**
 * Sync the Context Tree checkout for the authenticated runtime agent.
 *
 * Uses the SDK's agent-scoped `/api/v1/agent/context-tree/info` route, so the
 * binding follows the agent's own organization rather than the caller's
 * default organization. Local checkouts are still isolated per `(repo, branch)`.
 */
export async function syncAgentContextTree(
  sdk: FirstTreeHubSDK,
  log: (msg: string) => void,
): Promise<ContextTreeBinding | null> {
  return resolveContextTreeBinding(() => sdk.getAgentContextTreeConfig(), log);
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
 * keep `<workspacePath>/CLAUDE.md` as a relative symlink to it.
 *
 * One file, both providers: Codex's `project_root_markers` walk finds
 * `AGENTS.md` directly; Claude Code's `settingSources: ["project"]` follows
 * the `CLAUDE.md` symlink. Edits to the briefing layout only need to land in
 * the {@link buildAgentBriefing} producer.
 */
export function writeAgentBriefing(workspacePath: string, content: string): void {
  writeFileSync(join(workspacePath, "AGENTS.md"), content, "utf-8");
  ensureClaudeMdSymlink(workspacePath);
}

/**
 * Make `<workspacePath>/CLAUDE.md` a relative symlink to `AGENTS.md`. Replaces
 * a stale regular file or broken/mis-targeted symlink left from earlier
 * bootstrap formats; a no-op when the symlink is already correct.
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
export function ensureClaudeMdSymlink(workspacePath: string): void {
  const claudeMd = join(workspacePath, "CLAUDE.md");
  const targetRel = "AGENTS.md";
  try {
    const stats = lstatSync(claudeMd);
    if (stats.isSymbolicLink() && readlinkSync(claudeMd) === targetRel) return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const tempPath = join(workspacePath, `.CLAUDE.md.${randomBytes(6).toString("hex")}.tmp`);
  symlinkSync(targetRel, tempPath);
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

/**
 * Path to the cached Context-Tree HEAD inside the agent home. Used by the
 * handler to detect upstream Tree commit drift between session starts and
 * trigger a fresh `installFirstTreeIntegration` (proposals/agent-session-
 * cwd-redesign.20260519.md §⑤.3).
 */
export const CONTEXT_TREE_HEAD_REL = join(FIRST_TREE_RUNTIME_DIR, "context-tree-head");

/**
 * Best-effort read of the Context Tree's current HEAD commit. Returns `null`
 * when the path is missing or `git rev-parse` fails (e.g. detached worktree
 * with no commits) — drift detection is "fail open" in that case: callers
 * treat null as "unknown" and skip the drift-driven re-bootstrap.
 */
export function readContextTreeHead(contextTreePath: string | null): string | null {
  if (!contextTreePath || !existsSync(join(contextTreePath, ".git"))) return null;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: contextTreePath,
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** Read the cached HEAD value, if any. */
export function readCachedContextTreeHead(workspacePath: string): string | null {
  const path = join(workspacePath, CONTEXT_TREE_HEAD_REL);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Per-agent-home pin file for the CLI version that performed the last
 * bootstrap. Distinct from {@link CONTEXT_TREE_HEAD_REL}: this drifts when
 * the operator upgrades the `first-tree` binary (a new shipped skills
 * payload typically ships with it), even if the Context Tree HEAD is
 * unchanged. Without this trigger, agent homes silently keep stale
 * `.agents/skills/*` after a `first-tree upgrade` until the Context Tree
 * happens to move.
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

/** Persist the current HEAD value alongside the sentinel. */
export function writeContextTreeHead(workspacePath: string, head: string | null): void {
  const path = join(workspacePath, CONTEXT_TREE_HEAD_REL);
  if (head === null) return;
  ensureWorkspaceRuntimeDir(workspacePath);
  writeFileSync(path, head, "utf-8");
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
 * through the unified per-turn briefing file written by {@link
 * writeAgentBriefing} (which the handler invokes on every start/resume after
 * computing the briefing content via {@link buildAgentBriefing}).
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
 * Install the shipped first-tree skill payloads into the workspace.
 *
 * Copies each tree skill (see {@link TREE_SKILL_NAMES}) from the npm
 * package's bundled `skills/` directory into
 * `<workspacePath>/.agents/skills/<name>/` and makes
 * `<workspacePath>/.claude/skills/<name>` a relative symlink to it.
 *
 * Per-skill VERSION gate: when the on-disk VERSION matches the bundled
 * VERSION, the rm+cp+symlink-replace is skipped (fast path on every
 * session start). Mismatched or missing → full reinstall of just that
 * skill.
 *
 * Returns `false` if ANY skill failed; caller logs the failure and
 * continues. The agent session still starts — the missing skill just
 * isn't reachable on disk.
 *
 * Pre-2026-06 history: this used to shell out to `first-tree tree skill
 * install --root <workspacePath>`. The CLI dependency was removed when
 * the @first-tree/client package started bundling skill payloads
 * directly (see `scripts/copy-bundled-skills.mjs`). No more `npx -y
 * first-tree@latest` cold-download on first run, no more `binName` PATH
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
 * Install the **core** (Context-Tree-independent) first-tree skill payloads.
 * Currently a no-op because `CORE_SKILL_NAMES` is empty — the wiring stays
 * so re-introducing a core skill needs no bootstrap edit.
 *
 * Same inline-from-bundled-payload model as
 * {@link installFirstTreeIntegration}: no shell-out, no CLI dependency.
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
      log(`Core skills: ${parts.join("; ")}`);
    }
    for (const f of result.failed) {
      log(`Core skill install failed (${f.name}): ${f.reason.slice(0, 200)}`);
    }
    return result.ok;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Core skill install skipped: ${msg.slice(0, 200)}`);
    return false;
  }
}

/**
 * One predeclared source repository the handler checked out at the **top
 * level** of the agent home before the agent ran (e.g. `<agentHome>/<localPath>/`).
 * Surfaced in the per-chat system prompt so the LLM knows the absolute
 * path and upstream coordinates.
 *
 * Note: the old "PredeclaredWorktree" model put these under
 * `<agentHome>/worktrees/<name>/`. Per the 2026-05-22 redesign, source
 * checkouts sit at the top level so the `worktrees/` subdir is reserved
 * **entirely** for agent-on-demand worktrees the LLM creates per task.
 */
export type PredeclaredSourceRepo = {
  /** Absolute path on the host filesystem (top level of the agent home). */
  absolutePath: string;
  url: string;
  ref?: string;
  branch?: string;
};

/**
 * A First Tree-managed worktree has a `.git` FILE (not directory) pointing back at
 * the bare mirror — `git worktree add` produces this shape. Used by the
 * source-repo reuse decision in both handlers to distinguish "checkout we
 * created earlier" from "operator dropped an unrelated directory in the
 * way".
 */
export function isHubWorktreeMarker(path: string): boolean {
  const gitMarker = join(path, ".git");
  if (!existsSync(gitMarker)) return false;
  try {
    return statSync(gitMarker).isFile();
  } catch {
    return false;
  }
}

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
