import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDataDir } from "@first-tree/shared/config";
import type { ContextTreeConfig } from "../sdk.js";
import { type AccessTokenProvider, FirstTreeHubSDK } from "../sdk.js";
import type { ChatContext } from "./chat-context.js";
import { renderChatContextSection } from "./chat-context-section.js";
import { getCliBinding } from "./cli-binding.js";
import { httpsToSshBaseRewrite } from "./git-mirror-manager.js";
import type { AgentIdentity } from "./handler.js";

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
 * to a single shared sync. Each Hub `agent:bind` still resyncs the tree
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
    execFileSync("git", ["--version"], { stdio: "ignore" });
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
      const currentBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: cloneDir,
        encoding: "utf-8",
        timeout: 5_000,
      }).trim();
      if (currentBranch !== branch) {
        execFileSync("git", ["checkout", branch], {
          cwd: cloneDir,
          stdio: "pipe",
          timeout: 10_000,
        });
        log(`Context Tree switched to branch ${branch}`);
      }

      // Pull latest changes
      execFileSync("git", ["pull", "--ff-only"], {
        cwd: cloneDir,
        stdio: "pipe",
        timeout: 30_000,
      });
      log(`Context Tree updated (pull)`);
    } else {
      // First clone
      mkdirSync(cloneDir, { recursive: true });
      execFileSync("git", ["clone", "--branch", branch, "--single-branch", repo, cloneDir], {
        stdio: "pipe",
        timeout: 60_000,
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
        execFileSync("git", ["clone", "--branch", branch, "--single-branch", sshRepo, cloneDir], {
          stdio: "pipe",
          timeout: 60_000,
        });
        log("Context Tree cloned via SSH fallback");
        // Report the SSH URL as ground truth — `git remote get-url origin`
        // on this checkout will be the SSH form, and downstream consumers
        // (`first-tree tree integrate --tree-url`, telemetry) should match
        // the actual remote rather than the configured-but-unusable HTTPS.
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
        execFileSync("git", ["clone", "--branch", branch, "--single-branch", repo, cloneDir], {
          stdio: "pipe",
          timeout: 60_000,
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

export type AgentBriefingFormat = "claude" | "agents-md";

export type AgentBriefing = {
  format: AgentBriefingFormat;
  /** Pre-rendered markdown to materialise as the briefing file. */
  content: string;
};

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
 * Walk up from the current module to find the closest `package.json` with
 * a `version` field.
 *
 * - **Published / `dev-install.sh` bundle** (the path that actually matters
 *   for the drift trigger): `bootstrap.ts` is inlined into an `apps/cli/
 *   dist/<chunk>.mjs` chunk, so the walk goes `dist/<chunk>.mjs` → `dist/`
 *   → the CLI manifest. CI publish rewrites that manifest's `name`/`bin`
 *   to the channel before `pnpm build`, so the version we read is the
 *   consumer-facing CLI version (`first-tree` / `first-tree-staging` /
 *   `first-tree-dev`). This is what `first-tree upgrade` bumps.
 * - **Source-tree `tsx` / vitest runs**: there is no bundle; the walk
 *   from `packages/client/src/runtime/bootstrap.ts` hits the
 *   `@first-tree/client` manifest first. That package is `private`
 *   (no published release bumps it), so the pin doesn't track CLI
 *   versions in dev mode. Drift detection still works correctly because
 *   each invocation reads the same value; the dev-mode pin just won't
 *   tick when the operator runs a real `pnpm install -g first-tree@...`.
 *   Acceptable: dev iteration is the wrong place to validate CLI-upgrade
 *   refresh semantics anyway.
 *
 * Imported from here (not from `apps/cli`) to keep the client → CLI
 * dependency direction one-way.
 *
 * Returns `null` if the walk exhausts every parent — we treat that as
 * "version unknown" and fall back to the sentinel-only path, never as
 * "drifted".
 */
export function resolveBundledCliVersion(moduleUrl: string = import.meta.url): string | null {
  let dir = dirname(fileURLToPath(moduleUrl));
  for (let i = 0; i < 10; i += 1) {
    const candidate = resolve(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
        if (typeof parsed.version === "string" && parsed.version.length > 0) {
          return parsed.version;
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
  return null;
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
  /**
   * Provider-specific runtime briefing materialised at the workspace root.
   * `agents-md` writes `AGENTS.md` (Codex reads it from the project root via
   * the marker); `claude` is a no-op file-write because Claude Code receives
   * the system prompt through the SDK option directly.
   */
  briefing?: AgentBriefing;
};

/**
 * Bootstrap the agent's home directory with stable, agent-level files plus
 * the workspace-root marker (and an optional provider-specific briefing).
 *
 * Writes identity.json, context/agent-instructions.md (if context tree
 * available), tools.md, the `.first-tree-workspace` marker, and — for
 * Codex — `AGENTS.md`. Per the agent-session-cwd-redesign (proposals/
 * 2026-05-19) **only agent-level stable fields** live in identity.json;
 * per-chat data (chatId, participants) is injected per turn via the
 * Claude/Codex SDK system-prompt append channel, built by
 * {@link buildChatSystemPrompt}.
 *
 * Idempotent: safe to call on every handler start() / resume(), though in
 * the per-agent-home model the handler short-circuits this when the
 * `.agent/init-complete` sentinel is already present.
 */
export function bootstrapWorkspace(options: BootstrapOptions): void {
  const { workspacePath, identity, contextTreePath, serverUrl, briefing } = options;
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

  // 2. Copy organizational context from Context Tree (if available).
  // Per PRD D7, the agent's behavior instructions live in the Hub-managed
  // `agent_configs.payload.prompt.append` and are injected via the Claude
  // Code SDK's `systemPrompt.append`, not via a workspace file.
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

  // 5. Provider-specific briefing
  if (briefing?.format === "agents-md") {
    writeFileSync(join(workspacePath, "AGENTS.md"), briefing.content, "utf-8");
  }
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

function defaultInstallExec(command: string, args: string[], options: { cwd: string; timeout: number }): void {
  execFileSync(command, args, {
    cwd: options.cwd,
    stdio: "pipe",
    timeout: options.timeout,
    encoding: "utf-8",
  });
}

/**
 * Install the first-tree skill and FIRST-TREE-SOURCE-INTEGRATION block into
 * the workspace by shelling out to the channel-resolved CLI's `tree integrate`.
 *
 * Resolution order for the CLI binary (binName/packageName are channel-aware,
 * see {@link getCliBinding}):
 *   1. `<binName>` on PATH — preferred for runtime images that pre-install it.
 *   2. `npx -y <packageName>@latest` — fallback that downloads on first run.
 *      Skipped for the dev channel (`packageName === null`) because dev
 *      binaries are not published to npm.
 *
 * Graceful degradation: returns false on failure and logs. The session still
 * starts; the agent just doesn't have the first-tree skill wired up.
 */
export function installFirstTreeIntegration(options: InstallFirstTreeIntegrationOptions): boolean {
  const { workspacePath, contextTreePath, workspaceId, treeRepoUrl, log } = options;
  const exec = options.exec ?? defaultInstallExec;
  const { binName, packageName } = getCliBinding();

  // `<binName> tree integrate` resolves the source/workspace path from the
  // process cwd — it does NOT accept a `--source-path` flag. We set
  // `cwd: workspacePath` below; passing a flag the CLI doesn't recognise
  // makes every invocation exit 1 with "unknown option '--source-path'".
  const integrateArgs = [
    "tree",
    "integrate",
    "--tree-path",
    contextTreePath,
    "--mode",
    "workspace-root",
    "--workspace-id",
    workspaceId,
    ...(treeRepoUrl ? ["--tree-url", treeRepoUrl] : []),
  ];

  const attempts: Array<{ command: string; args: string[]; label: string }> = [
    { command: binName, args: integrateArgs, label: `${binName} (PATH)` },
    // Dev channel publishes no npm tarball, so skip the npx fallback entirely
    // — there is nothing to fetch. Falls through to "PATH attempt failed →
    // graceful degradation" which is the right behaviour for dev anyway:
    // the developer is expected to have the in-tree CLI installed via
    // scripts/dev-install.sh.
    ...(packageName
      ? [
          {
            command: "npx",
            args: ["-y", `${packageName}@latest`, ...integrateArgs],
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
 * A Hub-managed worktree has a `.git` FILE (not directory) pointing back at
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
      "working directory. Treat them as **read-only / browse-only baselines** —",
      "they are shared with every chat of this agent, so do **not** modify them",
      "in place or switch their branches:",
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
    "**No worktrees are pre-created.** When you need to modify code, branch off",
    `into a new worktree under \`${agentHome}/worktrees/<task-name>/\` and work there:`,
  );
  worktreeBlock.push("");
  worktreeBlock.push(
    "```bash",
    `# from a source repo, e.g. ${sourceRepos[0]?.absolutePath ?? `${agentHome}/<source-repo>`}`,
    `git worktree add ${agentHome}/worktrees/<task-name> -b <new-branch>`,
    "```",
  );
  worktreeBlock.push("");
  worktreeBlock.push(
    "Replace `<task-name>` with something descriptive (e.g. `<repo>-<short-task-id>`)",
    "and `<new-branch>` with a real branch name. When finished, the operator can",
    "clean up worktrees with `git worktree remove`.",
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

function generateToolsDoc(): string {
  // CLI binary name resolved at runtime from the channel-aware binding the
  // CLI entrypoint installs via `setCliBinding`. Prod = "first-tree", staging
  // = "first-tree-staging", dev = "first-tree-dev". Baking the channel-correct
  // name into tools.md is what lets the agent's `<bin> chat send` and
  // `<bin> attention raise` invocations actually find the CLI on PATH —
  // hardcoding "first-tree" used to leave staging/dev agents calling a
  // binary that wasn't installed on the host.
  const bin = getCliBinding().binName;
  return `# Agent Hub SDK

You are running inside **Agent Hub**, a messaging platform for agent teams.

- Messages from other team members arrive as your prompt input. Each message has a
  \`[From: <agent-name>]\` header — that name is what you pass back to \`chat send\`.
- **Your final response text is delivered to the chat for human observers to read.
  It does NOT wake other agents.** To make another agent take action, use
  \`${bin} chat send <name>\` explicitly (see "Communication Rules" below).
- **Stay silent when you have nothing to add.** Not every message needs a reply.
  If you have nothing new for the recipient, output nothing and the runtime ends the turn.
- For **proactive communication** (other agents, other chats, or different format),
  use the \`${bin}\` CLI below.

## Communication Rules

Your final response text is delivered to the chat for **human observers**
to read. It does NOT wake other agents.

To make another agent take action, you MUST explicitly call:

    ${bin} chat send <name> "..."

Decision guide (based on participant \`type\` in the Current Chat Context block):

- Target is a **human** in this chat → your final text is enough; do not
  redundantly chat send (it just adds noise).
- Target is an **agent** in this chat → they will NOT see your final text
  as a wake signal. You MUST chat send <name> if you need them to act.
- No specific target (just narrating progress / thinking aloud) → final
  text only; no send needed.

**Fallback** (if Current Chat Context block is missing — context injection
may have failed): use conservative mode — all cross-agent collaboration
goes through explicit \`chat send\`; do not rely on final text to wake
anyone.

## Sending Messages

The CLI auto-reads its config from env — no setup needed.

\`\`\`bash
# Send to an agent by NAME (uuids are NOT accepted — run \`${bin} agent list\` for names).
# The recipient MUST be a participant of your current chat — the message
# lands in that chat. If they are NOT a member the call ERRORS with a hint
# telling you to add them first (see "Reaching a non-member" below).
${bin} chat send <agentName> "your message"

# Pull a non-member into your current chat first, then send normally.
${bin} chat invite <agentName>
${bin} chat send <agentName> "your message"

# Markdown format (default is text)
${bin} chat send <agentName> -f markdown "**bold**"

# Pipe long / multiline content via stdin
echo "long body" | ${bin} chat send <agentName>
\`\`\`

**Reaching another agent**:

- **Already a member of this chat** → \`chat send <agentName> "..."\`. The
  message lands in the current chat and the recipient is woken if they were
  @mentioned (or — for two-speaker chats — implicitly).
- **Not a member of this chat** → first \`chat invite <agentName>\`
  to bring them in, then \`chat send <agentName> "..."\` like normal. Hub
  keeps a single group-chat model — there is no side-conversation escape
  hatch. \`@<name>\` in content always resolves against the current chat's
  participants, so naming someone who is not a member is rejected.

The CLI **only addresses agents by name**. You cannot route by chat-id from
this command.

**Content rules (important):**

- Pass content as a **raw string** — never \`JSON.stringify\` it first. Wrapping in
  outer quotes + \`\\n\` escapes produces a literal \`"@x ...\\n..."\` that the UI
  cannot render as markdown.
- For multi-line / markdown / special chars (quotes, \`$\`, backticks, newlines),
  use **stdin** with real newlines, plus \`-f markdown\`.

## When You Need a Human (Need-Human-Attention)

**Hard rule:** if you need a human to decide, endorse, clarify, or just know —
use the **Need-Human-Attention (NHA)** primitive, NOT a plain \`chat send\` that
asks "could you confirm…" / "please decide…". NHA gives the ask a target, a
state machine, a typed response slot, and a UI surface the human cannot miss.
A plain chat send asking for a decision is easy to lose in the scroll and
gives your turn no clean place to resume.

\`\`\`bash
# Ask (expects a reply) — your turn resumes when the human responds.
${bin} attention raise \\
  --chat <chat-id-of-this-conversation> \\
  --target <human-agent-name> \\
  --subject "<one-line summary>" \\
  --body "<context, options, what you'll do on each path>" \\
  --requires-response

# Notify (fire-and-forget) — closes on creation, no response slot.
${bin} attention raise --chat <id> --target <name> \\
  --subject "deployed v1.4.2" --body "..."
\`\`\`

**Trigger checklist — use NHA, not \`chat send\`, when any of:**

- You're about to ask a human to **decide**, **approve**, **endorse**, or
  **clarify ambiguous intent** before you can continue.
- You need to **escalate** because a guardrail / blocker fires (cannot
  self-resolve safely).
- You need to **inform** a human of a state change that affects them
  (deploy done, PR merged, incident detected) — use \`--requires-response\`
  off for the notification variant.

**When \`chat send\` is still correct:**

- Coordinating with another **agent** in the chat.
- Narrative / progress updates that don't need any action.
- Sending the actual answer / result the human asked for (NHA is for the
  *ask*; the *delivery* is normal chat).

**Skill reference:** read \`.claude/skills/attention/SKILL.md\` (or
\`.agents/skills/attention/SKILL.md\`) for the full playbook — body
template, waiting behaviour, no-response handling, and the four lenses
(Endorse / Information / Direction / Inform).

## Source Repos

For development tasks, prefer the repo worktrees already present in this workspace.
`;
}
