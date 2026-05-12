import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DATA_DIR } from "@agent-team-foundation/first-tree-hub-shared/config";
import { type AccessTokenProvider, FirstTreeHubSDK } from "../sdk.js";
import type { AgentIdentity } from "./handler.js";

const CONTEXT_TREE_DIR = join(DEFAULT_DATA_DIR, "context-tree");

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

/**
 * Sync the shared Context Tree git clone.
 *
 * Clones on first run, pulls on subsequent runs.
 * Returns the binding on success, null on failure (graceful degradation).
 */
export async function syncContextTree(
  serverUrl: string,
  getAccessToken: AccessTokenProvider,
  log: (msg: string) => void,
  userAgent?: string,
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
    const sdk = new FirstTreeHubSDK({ serverUrl, getAccessToken, userAgent });
    const config = await sdk.getContextTreeConfig();
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

  // 3. Clone or pull
  try {
    if (existsSync(join(CONTEXT_TREE_DIR, ".git"))) {
      // Ensure we're on the expected branch before pulling
      const currentBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: CONTEXT_TREE_DIR,
        encoding: "utf-8",
        timeout: 5_000,
      }).trim();
      if (currentBranch !== branch) {
        execFileSync("git", ["checkout", branch], {
          cwd: CONTEXT_TREE_DIR,
          stdio: "pipe",
          timeout: 10_000,
        });
        log(`Context Tree switched to branch ${branch}`);
      }

      // Pull latest changes
      execFileSync("git", ["pull", "--ff-only"], {
        cwd: CONTEXT_TREE_DIR,
        stdio: "pipe",
        timeout: 30_000,
      });
      log(`Context Tree updated (pull)`);
    } else {
      // First clone
      mkdirSync(CONTEXT_TREE_DIR, { recursive: true });
      execFileSync("git", ["clone", "--branch", branch, "--single-branch", repo, CONTEXT_TREE_DIR], {
        stdio: "pipe",
        timeout: 60_000,
      });
      log(`Context Tree cloned from ${repo} (branch: ${branch})`);
    }
    return { path: CONTEXT_TREE_DIR, repoUrl: repo, branch };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Context Tree sync failed: ${msg}`);
    log("Check that git credentials (SSH key or credential helper) are configured for this repo");

    // If pull failed due to diverged history, try re-clone.
    // Only re-clone when the error indicates a non-recoverable git state.
    // For transient errors (network, auth), preserve existing clone.
    const isGitStateError =
      msg.includes("cannot fast-forward") || msg.includes("not possible to fast-forward") || msg.includes("CONFLICT");

    if (isGitStateError && existsSync(join(CONTEXT_TREE_DIR, ".git"))) {
      log("Diverged history detected, attempting fresh clone...");
      try {
        rmSync(CONTEXT_TREE_DIR, { recursive: true, force: true });
        mkdirSync(CONTEXT_TREE_DIR, { recursive: true });
        execFileSync("git", ["clone", "--branch", branch, "--single-branch", repo, CONTEXT_TREE_DIR], {
          stdio: "pipe",
          timeout: 60_000,
        });
        log("Context Tree re-cloned successfully");
        return { path: CONTEXT_TREE_DIR, repoUrl: repo, branch };
      } catch {
        log("Context Tree re-clone also failed, continuing without context");
      }
    }

    // Return existing clone path if available (preserves local work on transient errors)
    if (existsSync(join(CONTEXT_TREE_DIR, ".git"))) {
      log("Using existing Context Tree clone despite sync failure");
      return { path: CONTEXT_TREE_DIR, repoUrl: repo, branch };
    }

    return null;
  }
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
  const { workspacePath, identity, contextTreePath, serverUrl, chatId, briefing } = options;
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

## How You Communicate

You are running inside **Agent Hub**, a messaging platform for agent teams.

- Messages from other team members arrive as your prompt input
- Each message includes a \`[From: <agent-name>]\` header — that name is also
  what you pass back to \`agent send\` to reply to or address that agent
- **Your final text response is automatically delivered** to the chat — just respond normally
- For **proactive communication** (sending to other agents, other chats, or structured data),
  use the \`first-tree-hub\` CLI below
- **Use your judgment about when to respond.** Not every message requires a reply.
  Your role and responsibilities are injected via the Hub-managed system prompt.

## Environment Variables

These are injected automatically when the agent process starts:

| Variable | Description |
|----------|-------------|
| \`FIRST_TREE_HUB_SERVER_URL\` | Server address for API calls |
| \`FIRST_TREE_HUB_ACCESS_TOKEN\` | User member access JWT (short-lived) |
| \`FIRST_TREE_HUB_AGENT_ID\` | YOUR own agent UUID. The CLI reads it to identify you as the sender — never pass it as a \`send\` target. |
| \`FIRST_TREE_HUB_CHAT_ID\` | The chat this session is currently bound to. The CLI uses it to route messages — you don't need to pass it manually. |

The \`first-tree-hub\` CLI reads these automatically — no extra setup needed.

## Sending Messages

Use the \`first-tree-hub agent send\` CLI — it reads the env vars above and
attaches the \`Authorization\` + \`X-Agent-Id\` headers automatically:

\`\`\`bash
# Send to another agent — first positional argument is the recipient's NAME
# (NOT a uuid; uuids in chat history / participant lists are not accepted).
# Run \`first-tree-hub agent list\` to see available names.
#
# Routing: if the recipient is a participant of your current chat (typically
# the case in a group chat where someone @-mentioned you to talk to them),
# the message stays in that chat. Otherwise it falls back to a direct chat
# between you and the recipient. You don't need to think about which.
first-tree-hub agent send <agentName> "your message"

# Send into a specific chat by id — use this only when you explicitly want
# to address a chat your current session is NOT bound to.
first-tree-hub agent send --chat <chatId> "your message"

# Send markdown (default format is text)
first-tree-hub agent send <agentName> -f markdown "**bold** message"

# Reply to a specific message
first-tree-hub agent send <agentName> --reply-to <messageId> "reply content"

# Pipe long content via stdin (recommended for special characters)
echo "long message body" | first-tree-hub agent send <agentName>
\`\`\`

> Agent uuids appear in \`agent chats\`, chat history, and participant lists,
> but they are NOT accepted by \`agent send\` — always use the name.

For content with quotes, \`$\`, backticks, or newlines, prefer stdin to avoid shell escaping issues.
`;
}
