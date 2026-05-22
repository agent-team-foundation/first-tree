import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DATA_DIR } from "@first-tree/shared/config";
import type { ContextTreeConfig } from "../sdk.js";
import { type AccessTokenProvider, FirstTreeHubSDK } from "../sdk.js";
import type { ChatContext } from "./chat-context.js";
import { httpsToSshBaseRewrite } from "./git-mirror-manager.js";
import type { AgentIdentity } from "./handler.js";

const CONTEXT_TREE_REPOS_DIR = join(DEFAULT_DATA_DIR, "context-tree-repos");
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
  return join(CONTEXT_TREE_REPOS_DIR, digest);
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

function withContextTreeSyncLock(
  key: string,
  fn: () => Promise<ContextTreeBinding | null>,
): Promise<ContextTreeBinding | null> {
  const next = (contextTreeSyncLocks.get(key) ?? Promise.resolve(null))
    .catch(() => null)
    .then(fn)
    .finally(() => {
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

export type BootstrapOptions = {
  workspacePath: string;
  identity: AgentIdentity;
  contextTreePath: string | null;
  serverUrl: string;
  chatId: string;
  /**
   * Narrow chat-level identity block (topic + participants + optional owner)
   * fetched by the handler before calling this function. Optional so a
   * failed fetch degrades to the no-section path: identity.json drops the
   * field and CLAUDE.md / AGENTS.md never get the "Current Chat Context"
   * block. See proposals/hub-chat-message-v1-design §四 改造 3.
   */
  chatContext?: ChatContext;
  /**
   * Provider-specific runtime briefing materialised at the workspace root.
   * `agents-md` writes `AGENTS.md` (Codex reads it from the project root via
   * the marker); `claude` is a no-op file-write because Claude Code receives
   * the system prompt through the SDK option directly.
   */
  briefing?: AgentBriefing;
};

/**
 * Bootstrap a workspace with `.agent/` directory files plus the workspace
 * root marker (and an optional provider-specific briefing).
 *
 * Writes identity.json, context/agent-instructions.md (if context tree
 * available), tools.md, the `.first-tree-workspace` marker, and — for
 * Codex — `AGENTS.md`. Idempotent: safe to call on every handler start()
 * and on resume().
 */
export function bootstrapWorkspace(options: BootstrapOptions): void {
  const { workspacePath, identity, contextTreePath, serverUrl, chatId, chatContext, briefing } = options;
  const agentDir = join(workspacePath, ".agent");
  const contextDir = join(agentDir, "context");

  // Clear stale context before repopulating (prevents serving outdated files).
  if (existsSync(contextDir)) {
    rmSync(contextDir, { recursive: true, force: true });
  }
  mkdirSync(contextDir, { recursive: true });

  // 1. Write identity.json
  const identityData = {
    agentId: identity.agentId,
    displayName: identity.displayName,
    type: identity.type,
    delegateMention: identity.delegateMention,
    metadata: identity.metadata,
    chatId,
    serverUrl,
    contextTreePath,
    ...(chatContext ? { chatContext } : {}),
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
 * the workspace by shelling out to `first-tree tree integrate`.
 *
 * Resolution order for the CLI binary:
 *   1. `first-tree` on PATH — preferred for runtime images that pre-install it.
 *   2. `npx -y first-tree@latest` — fallback that downloads on first run.
 *
 * Graceful degradation: returns false on failure and logs. The session still
 * starts; the agent just doesn't have the first-tree skill wired up.
 */
export function installFirstTreeIntegration(options: InstallFirstTreeIntegrationOptions): boolean {
  const { workspacePath, contextTreePath, workspaceId, treeRepoUrl, log } = options;
  const exec = options.exec ?? defaultInstallExec;

  // `first-tree tree integrate` resolves the source/workspace path from the
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
    { command: "first-tree", args: integrateArgs, label: "first-tree (PATH)" },
    {
      command: "npx",
      args: ["-y", "first-tree@latest", ...integrateArgs],
      label: "npx first-tree@latest",
    },
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

function generateToolsDoc(): string {
  return `# Agent Hub SDK

You are running inside **Agent Hub**, a messaging platform for agent teams.

- Messages from other team members arrive as your prompt input. Each message has a
  \`[From: <agent-name>]\` header — that name is what you pass back to \`chat send\`.
- **Your final response text is delivered to the chat for human observers to read.
  It does NOT wake other agents.** To make another agent take action, use
  \`first-tree-hub chat send <name>\` explicitly (see "Communication Rules" below).
- **Stay silent when you have nothing to add.** Not every message needs a reply.
  If you have nothing new for the recipient, output nothing and the runtime ends the turn.
- For **proactive communication** (other agents, other chats, or different format),
  use the \`first-tree-hub\` CLI below.

## Communication Rules

Your final response text is delivered to the chat for **human observers**
to read. It does NOT wake other agents.

To make another agent take action, you MUST explicitly call:

    first-tree-hub chat send <name> "..."

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
# Send to an agent by NAME (uuids are NOT accepted — run \`first-tree-hub agent list\` for names).
# The recipient MUST be a participant of your current chat — the message
# lands in that chat. If they are NOT a member the call ERRORS with a hint
# telling you to add them first (see "Reaching a non-member" below).
first-tree-hub chat send <agentName> "your message"

# Pull a non-member into your current chat first, then send normally.
first-tree-hub chat invite <agentName>
first-tree-hub chat send <agentName> "your message"

# Markdown format (default is text)
first-tree-hub chat send <agentName> -f markdown "**bold**"

# Pipe long / multiline content via stdin
echo "long body" | first-tree-hub chat send <agentName>
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

## Source Repos

For development tasks, prefer the repo worktrees already present in this workspace.
`;
}
