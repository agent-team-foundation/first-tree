import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
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
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { defaultDataDir } from "@first-tree/shared/config";
import type { ContextTreeConfig } from "../sdk.js";
import { type AccessTokenProvider, FirstTreeHubSDK } from "../sdk.js";
import type { ChatContext } from "./chat-context.js";
import { renderChatContextSection } from "./chat-context-section.js";
import { getCliBinding } from "./cli-binding.js";
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
 * the local checkout path AND the upstream coordinates `first-tree tree
 * integrate` needs to write a complete `local-tree.json` (without the URL
 * the skill cannot pull/push later).
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
 * Marker file written into every workspace so the Codex CLI's project-root
 * detection (configured via `project_root_markers: ["first-tree-workspace"]`)
 * stops at the workspace boundary instead of walking up the filesystem and
 * loading an unintended `AGENTS.md` from the operator's home or repo root.
 */
export const FIRST_TREE_WORKSPACE_MARKER = ".first-tree-workspace";

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
export const CONTEXT_TREE_HEAD_REL = join(".agent", "context-tree-head");

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
export const BUNDLED_CLI_VERSION_REL = join(".agent", "cli-version");

/**
 * Resolve a stable identifier for the bundled CLI that the handler can
 * compare against the cached `.agent/cli-version` to detect upgrades.
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
 *     CLAUDE.md / tools.md / shipped skills payload.
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
  // be noise in the `.agent/cli-version` pin.
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
  mkdirSync(join(workspacePath, ".agent"), { recursive: true });
  writeFileSync(path, version, "utf-8");
}

/** Persist the current HEAD value alongside the sentinel. */
export function writeContextTreeHead(workspacePath: string, head: string | null): void {
  const path = join(workspacePath, CONTEXT_TREE_HEAD_REL);
  if (head === null) return;
  mkdirSync(join(workspacePath, ".agent"), { recursive: true });
  writeFileSync(path, head, "utf-8");
}

export type BootstrapOptions = {
  workspacePath: string;
  identity: AgentIdentity;
  contextTreePath: string | null;
  serverUrl: string;
};

/**
 * Bootstrap the agent's home directory with stable, agent-level files plus
 * the workspace-root marker.
 *
 * Writes identity.json, context/agent-instructions.md (if context tree
 * available), tools.md, and the `.first-tree-workspace` marker. Per the
 * agent-session-cwd-redesign (proposals/2026-05-19) **only agent-level stable
 * fields** live in identity.json; per-chat data (chatId, participants) flows
 * through the unified per-turn briefing file written by {@link
 * writeAgentBriefing} (which the handler invokes on every start/resume after
 * computing the briefing content via {@link buildAgentBriefing}).
 *
 * Idempotent: safe to call on every handler start() / resume(), though in
 * the per-agent-home model the handler short-circuits this when the
 * `.agent/init-complete` sentinel is already present.
 */
export function bootstrapWorkspace(options: BootstrapOptions): void {
  const { workspacePath, identity, contextTreePath, serverUrl } = options;
  const agentDir = join(workspacePath, ".agent");
  const contextDir = join(agentDir, "context");

  // Clear stale context before repopulating (prevents serving outdated files).
  if (existsSync(contextDir)) {
    rmSync(contextDir, { recursive: true, force: true });
  }
  mkdirSync(contextDir, { recursive: true });

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

  // 2. Copy organizational context from Context Tree (if available). The
  //    briefing builder reads back agent-instructions.md / domain-map.md from
  //    here when assembling AGENTS.md, so this is also the staging area for
  //    the unified briefing's tree sections.
  if (contextTreePath) {
    // Agent operating instructions (AGENT.md)
    const agentMdPath = join(contextTreePath, "AGENT.md");
    if (existsSync(agentMdPath)) {
      copyFileSync(agentMdPath, join(contextDir, "agent-instructions.md"));
    }

    // Organization domain map (root NODE.md)
    const rootNodePath = join(contextTreePath, "NODE.md");
    if (existsSync(rootNodePath)) {
      copyFileSync(rootNodePath, join(contextDir, "domain-map.md"));
    }
  }

  // 3. Write tools.md (static SDK reference)
  writeFileSync(join(agentDir, "tools.md"), generateToolsDoc(), "utf-8");

  // 4. Workspace-root marker — gates Codex's AGENTS.md walk-up so the agent
  //    sees the briefing in this workspace and not whatever sits in the
  //    operator's HOME / git root.
  writeFileSync(join(workspacePath, FIRST_TREE_WORKSPACE_MARKER), "", "utf-8");
}

export type InstallFirstTreeIntegrationExec = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number },
) => void;

export type InstallFirstTreeIntegrationOptions = {
  workspacePath: string;
  contextTreePath: string;
  workspaceId: string;
  treeRepoUrl?: string;
  log: (msg: string) => void;
  /**
   * Exec backend. Defaults to `execFileSync`. Override in tests to avoid
   * ESM-module spying limitations.
   */
  exec?: InstallFirstTreeIntegrationExec;
};

export type InstallCoreSkillsOptions = {
  workspacePath: string;
  log: (msg: string) => void;
  /**
   * Exec backend. Defaults to `execFileSync`. Override in tests to avoid
   * ESM-module spying limitations.
   */
  exec?: InstallFirstTreeIntegrationExec;
};

/**
 * Test-mode override for `defaultInstallExec`. Set via {@link __setTestInstallExec}
 * from `vitest.setup.ts` to a no-op so handler-level tests that go through
 * `handler.start()` do not actually shell out to the channel binary or `npx`
 * for `installCoreSkills` / `installFirstTreeIntegration`. Production leaves
 * this `null` and `defaultInstallExec` runs `execFileSync` normally.
 */
let testInstallExecOverride: InstallFirstTreeIntegrationExec | null = null;

/**
 * Install (or clear) a global test override for the install-exec backend.
 * Only call this from test setup files — the override is process-wide and
 * persists until cleared with `null`.
 */
export function __setTestInstallExec(exec: InstallFirstTreeIntegrationExec | null): void {
  testInstallExecOverride = exec;
}

// Kept synchronous (cf. the `execFileAsync` migration in this file): runs on
// the per-session bootstrap path inside the handler, not the per-agent-bind
// boot hot path, so even if `npx -y <package>@latest` stalls (cold download
// can be 10s+) it cannot pile up across the 6-slot startup window the way
// `syncContextTreeRepo` did. Re-evaluate if `installFirstTreeIntegration` is
// ever moved to a code path that runs N times in parallel at process start.
function defaultInstallExec(command: string, args: string[], options: { cwd: string; timeout: number }): void {
  if (testInstallExecOverride) {
    testInstallExecOverride(command, args, options);
    return;
  }
  execFileSync(command, args, {
    cwd: options.cwd,
    stdio: "pipe",
    timeout: options.timeout,
    encoding: "utf-8",
  });
}

/**
 * Install the shipped first-tree skill payloads into the workspace by shelling
 * out to the channel-resolved CLI's `tree skill install --root <workspacePath>`.
 *
 * Resolution order for the CLI binary (binName/packageName are channel-aware,
 * see {@link getCliBinding}):
 *   1. `<binName>` on PATH — preferred for runtime images that pre-install it.
 *   2. `npx -y <packageName>@latest` — fallback that downloads on first run.
 *      Skipped for the dev channel (`packageName === null`) because dev
 *      binaries are not published to npm.
 *
 * Framework files (workspace.json, AGENTS.md / CLAUDE.md) are written once at
 * onboarding by `tree init`, not re-emitted per session — this hook only
 * refreshes the on-disk skill payloads under `.agents/skills/` and
 * `.claude/skills/` so each session picks up the latest shipped versions.
 *
 * Graceful degradation: returns false on failure and logs. The session still
 * starts; the agent just doesn't have the first-tree skill wired up.
 */
export function installFirstTreeIntegration(options: InstallFirstTreeIntegrationOptions): boolean {
  const { workspacePath, log } = options;
  const exec = options.exec ?? defaultInstallExec;
  const { binName, packageName } = getCliBinding();

  const installArgs = ["tree", "skill", "install", "--root", workspacePath];

  const attempts: Array<{ command: string; args: string[]; label: string }> = [
    { command: binName, args: installArgs, label: `${binName} (PATH)` },
    // Dev channel publishes no npm tarball, so skip the npx fallback entirely
    // — there is nothing to fetch. Falls through to "PATH attempt failed →
    // graceful degradation" which is the right behaviour for dev anyway:
    // the developer is expected to have the in-tree CLI installed via
    // scripts/dev-install.sh.
    ...(packageName
      ? [
          {
            command: "npx",
            args: ["-y", `${packageName}@latest`, ...installArgs],
            label: `npx ${packageName}@latest`,
          },
        ]
      : []),
  ];

  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    if (!attempt) continue;
    try {
      exec(attempt.command, attempt.args, {
        cwd: workspacePath,
        timeout: 120_000,
      });
      log(`First-tree integration installed via ${attempt.label}`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Reasons the PATH attempt should fall through to npx@latest:
      //   - the binary isn't on PATH at all (ENOENT / "command not found")
      //   - the installed binary is older than the flags/subcommands we use
      //     (Commander rejects unknown options with `error: unknown option`
      //     and unknown subcommands with `error: unknown command`). Without
      //     this, an outdated `first-tree` on PATH wedges the integration
      //     in a silent-fail state — npx@latest would have worked.
      const binaryMissing = /ENOENT|not found|command not found/i.test(msg);
      const unsupportedByThisCli = /unknown (?:option|command|argument)|unrecognized option/i.test(msg);
      const shouldRetry = binaryMissing || unsupportedByThisCli;
      const isLastAttempt = index === attempts.length - 1;
      if (shouldRetry && !isLastAttempt) {
        log(`First-tree integration via ${attempt.label} unusable; falling back: ${msg.slice(0, 200)}`);
        continue;
      }
      log(`First-tree integration skipped (${attempt.label}): ${msg.slice(0, 200)}`);
      return false;
    }
  }

  return false;
}

/**
 * Install the **core** (Context-Tree-independent) first-tree skill payloads
 * into the workspace by shelling out to `<bin> tree skill install-core`.
 * Called unconditionally by every session bootstrap so any on-disk core
 * skill payload resolves even for agents without a Context Tree binding.
 * (The core skill set is currently empty, so this is effectively a no-op;
 * the wiring is kept so re-introducing a core skill needs no bootstrap
 * change.)
 *
 * Resolution and degradation match `installFirstTreeIntegration`: try the
 * channel-resolved binary on PATH, fall back to `npx -y <pkg>@latest` when
 * a published package exists, log + return false on terminal failure.
 */
export function installCoreSkills(options: InstallCoreSkillsOptions): boolean {
  const { workspacePath, log } = options;
  const exec = options.exec ?? defaultInstallExec;
  const { binName, packageName } = getCliBinding();

  const args = ["tree", "skill", "install-core", "--root", workspacePath];

  const attempts: Array<{ command: string; args: string[]; label: string }> = [
    { command: binName, args, label: `${binName} (PATH)` },
    ...(packageName
      ? [
          {
            command: "npx",
            args: ["-y", `${packageName}@latest`, ...args],
            label: `npx ${packageName}@latest`,
          },
        ]
      : []),
  ];

  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    if (!attempt) continue;
    try {
      exec(attempt.command, attempt.args, {
        cwd: workspacePath,
        timeout: 60_000,
      });
      log(`Core skills installed via ${attempt.label}`);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const binaryMissing = /ENOENT|not found|command not found/i.test(msg);
      const unsupportedByThisCli = /unknown (?:option|command|argument)|unrecognized option/i.test(msg);
      const shouldRetry = binaryMissing || unsupportedByThisCli;
      const isLastAttempt = index === attempts.length - 1;
      if (shouldRetry && !isLastAttempt) {
        log(`Core skill install via ${attempt.label} unusable; falling back: ${msg.slice(0, 200)}`);
        continue;
      }
      log(`Core skill install skipped (${attempt.label}): ${msg.slice(0, 200)}`);
      return false;
    }
  }

  return false;
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
 * `.agent/identity.json`. Implemented manually so a missing key on disk
 * (older bootstrap) is treated as drift even when `JSON.stringify` happens
 * to match by chance.
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

export type BuildChatSystemPromptOptions = {
  /** Absolute path to the agent home (cwd shared by every chat). */
  agentHome: string;
  /** Chat-level identity block; undefined when the fetch degraded. */
  chatContext: ChatContext | undefined;
  /**
   * Source repos the runtime pre-materialised from `agentConfig.gitRepos`.
   * Live at `<agentHome>/<localPath>/`, NOT under `worktrees/` — see
   * {@link PredeclaredSourceRepo}.
   */
  sourceRepos: ReadonlyArray<PredeclaredSourceRepo>;
};

/**
 * Build the per-chat system-prompt text the handler appends on every turn.
 *
 * Per the per-agent-home redesign, anything chat-specific MUST be delivered
 * as a prompt fragment so two concurrent sessions don't see each other's
 * chat-context cached on disk. The block carries:
 *
 *   1. Working-directory convention (cwd, persistence).
 *   2. Predeclared source repo list at top-level paths (read-only browse).
 *   3. The on-demand `worktrees/<name>/` convention agent uses for any
 *      modification.
 *   4. The shared `renderChatContextSection` block so chat ID, title, and
 *      participants survive the move off-disk.
 *
 * The 2026-05-22 redesign explicitly does **not** pre-create any worktree
 * at session start — the agent is told to `git worktree add` on demand.
 *
 * Returns an empty string only when chatContext AND sourceRepos are both
 * empty — callers can use that to decide whether to call
 * `appendSystemPrompt` at all.
 */
export function buildChatSystemPrompt(options: BuildChatSystemPromptOptions): string {
  const { agentHome, chatContext, sourceRepos } = options;
  const sections: string[] = [];

  sections.push(
    [
      "# Working Directory Convention",
      "",
      `Your fixed working directory is \`${agentHome}\`. This directory is shared`,
      "by every chat you participate in for this agent — files you create in one",
      "chat are visible from another. Operate accordingly:",
      "",
      "- Refer to paths by their **absolute** form (the values listed below) so",
      "  switching into a subdirectory does not break references.",
      "- Treat the agent home as persistent state. Memory, caches, and notes",
      "  accumulate across chats by design.",
    ].join("\n"),
  );

  if (sourceRepos.length > 0) {
    const lines: string[] = [];
    lines.push("");
    lines.push("## Source Repositories");
    lines.push("");
    lines.push(
      "The following repositories are pre-checked-out at the top level of your",
      "working directory. They sit on a long-lived hub-session branch that is",
      "**not** refreshed during this chat — the code may be many commits behind",
      "`origin/main`. Use them only for read-only orientation (grep, file layout,",
      "`git log`); for anything that must reflect current `main` (review, analysis,",
      "code changes), do not reuse this checkout — create a fresh worktree off",
      "`origin/<base>` (see below). Shared across every chat of this agent; do",
      "not modify them in place or switch their branches.",
    );
    lines.push("");
    for (const repo of sourceRepos) {
      const coords: string[] = [`url=${repo.url}`];
      if (repo.ref) coords.push(`ref=${repo.ref}`);
      if (repo.branch) coords.push(`branch=${repo.branch}`);
      lines.push(`- \`${repo.absolutePath}\`  (${coords.join(", ")})`);
    }
    sections.push(lines.join("\n"));
  }

  // Worktree convention block is emitted regardless of whether predeclared
  // source repos exist — the agent may also clone ad-hoc repos elsewhere
  // and the worktrees/<name>/ convention still applies for any modification.
  //
  // Per proposal §⑧ R3: use absolute paths in the snippet. LLMs sometimes
  // literal-copy `<placeholder>` strings, so only `<task-name>` and
  // `<new-branch>` are placeholders here — the home prefix is interpolated.
  const worktreeBlock: string[] = [];
  worktreeBlock.push("## Creating Worktrees On Demand");
  worktreeBlock.push("");
  worktreeBlock.push(
    "**No worktrees are pre-created.** Every new task starts by branching a",
    `fresh worktree under \`${agentHome}/worktrees/<task-name>/\` off a freshly-`,
    "fetched `origin/<base>` — do not reuse the pre-checked-out path above.",
  );
  worktreeBlock.push("");
  worktreeBlock.push(
    "```bash",
    `# from a source repo, e.g. ${sourceRepos[0]?.absolutePath ?? `${agentHome}/<source-repo>`}`,
    "git fetch origin",
    `git worktree add ${agentHome}/worktrees/<task-name> -b <new-branch> origin/main`,
    "```",
  );
  worktreeBlock.push("");
  worktreeBlock.push(
    "Replace `<task-name>`, `<new-branch>`, and `origin/main` to fit. When",
    "finished, the operator cleans up with `git worktree remove`.",
  );
  sections.push(worktreeBlock.join("\n"));

  const chatContextSection = renderChatContextSection(chatContext);
  if (chatContextSection) {
    // renderChatContextSection emits a "## Current Chat Context" block — we
    // surface it under the same header level as the working-dir block so
    // both render as top-level prompt sections.
    sections.push(chatContextSection.trimEnd());
  }

  return sections.join("\n\n");
}

export function generateToolsDoc(): string {
  // CLI binary name resolved at runtime from the channel-aware binding the
  // CLI entrypoint installs via `setCliBinding`. Prod = "first-tree", staging
  // = "first-tree-staging", dev = "first-tree-dev". Baking the channel-correct
  // name into tools.md is what lets the agent's `<bin> chat send`
  // invocations actually find the CLI on PATH —
  // hardcoding "first-tree" used to leave staging/dev agents calling a
  // binary that wasn't installed on the host.
  //
  // The long-form Sending Messages CLI usage (chat send / chat invite
  // syntax, markdown / stdin, mention-resolution mechanics) lives in the
  // top-level `first-tree` skill (SKILL.md + references/agent-
  // communication.md) — the dedicated `first-tree-cloud` skill it used
  // to live in was deleted because almost all of its content was
  // operator-facing (login, daemon install, agent create, etc.) and
  // never used by an in-chat agent at runtime. What stays here:
  //   - runtime safety invariants the result-sink + silent-turn guard
  //     depend on (final-text contract, silent-turn, Issue #389);
  //   - the short behavioural directives (Decision guide table + Fallback
  //     paragraph) that every agent needs regardless of whether the
  //     `first-tree` skill is installed in its workspace.
  // Why the second group stays inline: `first-tree` is in
  // `TREE_SKILL_NAMES` (only installed alongside a Context Tree binding),
  // not `CORE_SKILL_NAMES`. A tree-less agent (contextTreePath: null —
  // explicitly supported per CLAUDE.md "Context Tree integration is
  // optional") would otherwise be pointed at a skill that doesn't exist
  // on its disk and silently lose the decision guide.
  const bin = getCliBinding().binName;
  return `# First Tree Agent Runtime

You are running inside **First Tree**, a messaging platform for agent teams.

- Messages from other team members arrive as your prompt input. Each message has a
  \`[From: <agent-name>]\` header — that name is what you pass back to \`chat send\`.
- **Your final response text is delivered to the chat for human observers to read.
  It does NOT wake other agents.** To make another agent take action, run
  \`${bin} chat send <name>\` explicitly.
- **Stay silent when you have nothing to add.** Not every message needs a reply.
  If you have nothing new for the recipient, output nothing and the runtime ends the turn.
- **Content rules (Issue #389):** pass content as a **raw string** — never
  \`JSON.stringify\` it first. Wrapping in outer quotes + \`\\n\` escapes produces a
  literal \`"@x ...\\n..."\` row that the UI cannot render as markdown.

## Communication Rules

Decision guide (based on participant \`type\` in the Current Chat Context block):

- Target is a **human** in this chat → your final text is enough; do not
  redundantly \`chat send\` (it just adds noise).
- Target is an **agent** in this chat → they will NOT see your final text
  as a wake signal. You MUST \`${bin} chat send <name>\` if you need them to act.
- No specific target (just narrating progress / thinking aloud) → final
  text only; no send needed.

**Fallback** (if the Current Chat Context block is missing — context
injection may have failed): use conservative mode — all cross-agent
collaboration goes through explicit \`chat send\`; do not rely on final
text to wake anyone.

## Workspace Collaboration

For the full \`chat send\` / \`chat invite\` CLI usage — syntax, markdown /
stdin, reaching non-members, mention resolution — load the top-level
**\`first-tree\` skill** (and its \`references/agent-communication.md\`).
The skill's \`description\` triggers progressive disclosure whenever the user
mentions chat, daemon, agent config, or anything related to First Tree.

Substitute \`${bin}\` for the literal \`first-tree\` in any examples you read
there — this agent's CLI binary on PATH is \`${bin}\`. **Tree-less agents**
(no Context Tree binding) won't have \`first-tree\` installed on disk;
the Communication Rules above are inline here for exactly that reason — the
sunk content is the long CLI mechanics, not the routing rules.

## When You Need a Human

Asking a human is [pending redesign, 自行判断].

## Naming this Chat (Topic)

The workspace chat list uses each chat's \`topic\` as its label. A good topic
is a short (≤ 30 chars) phrase that tells a teammate at a glance what this
chat is about — e.g. "调研 chat rename 方案" or "本周 ship 计划".

The current value is shown in the "Current Chat Context" block above as
either an explicit \`Topic: <value>\` or the sentinel \`Topic: (unset ...)\`.

**Two hard rules:**

1. **Topic is unset → set one before ending this turn.**
   When the context block shows \`Topic: (unset ...)\`, run:

       ${bin} chat set-topic "<short phrase>"

   The fallback label the workspace would otherwise show ("first 50 chars
   of the first message" / "alice, bob-bot") is rarely distinctive across
   many chats — naming the chat is a cheap win.

2. **Topic is set but no longer matches what this chat is about → update it.**
   Use judgment: don't churn the topic for minor digressions. Only run
   \`${bin} chat set-topic "<new phrase>"\` when a teammate scanning the
   workspace list would be misled by the current value.

**Exception: GitHub-sourced topics — leave them alone.**

Topics that look like \`PR repo#307: title\`, \`Issue repo#42\`, \`PR Review
repo#X: ...\`, \`Discussion repo#X\`, or \`Commit repo@sha\` were auto-set
by First Tree when the chat was minted from a GitHub event, and First Tree keeps them in
sync with the upstream PR/issue title. Overriding them with your own label
loses the repo / entity-id anchor that makes the chat list useful. **Do
not run \`set-topic\` on a chat whose topic already has that shape.**
`;
}
