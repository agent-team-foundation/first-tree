import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_DATA_DIR } from "@agent-team-foundation/first-tree-hub-shared/config";
import { FirstTreeHubSDK } from "../sdk.js";
import type { AgentIdentity } from "./handler.js";

const CONTEXT_TREE_DIR = join(DEFAULT_DATA_DIR, "context-tree");

/**
 * Sync the shared Context Tree git clone.
 *
 * Clones on first run, pulls on subsequent runs.
 * Returns the clone path on success, null on failure (graceful degradation).
 */
export async function syncContextTree(
  serverUrl: string,
  token: string,
  log: (msg: string) => void,
): Promise<string | null> {
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
    const sdk = new FirstTreeHubSDK({ serverUrl, token });
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
    return CONTEXT_TREE_DIR;
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
        return CONTEXT_TREE_DIR;
      } catch {
        log("Context Tree re-clone also failed, continuing without context");
      }
    }

    // Return existing clone path if available (preserves local work on transient errors)
    if (existsSync(join(CONTEXT_TREE_DIR, ".git"))) {
      log("Using existing Context Tree clone despite sync failure");
      return CONTEXT_TREE_DIR;
    }

    return null;
  }
}

export type BootstrapOptions = {
  workspacePath: string;
  identity: AgentIdentity;
  contextTreePath: string | null;
  serverUrl: string;
  chatId: string;
};

/**
 * Bootstrap a workspace with .agent/ directory files.
 *
 * Writes identity.json, context/self.md (if context tree available), and tools.md.
 * Designed to be called on every handler start() and conditionally on resume().
 */
export function bootstrapWorkspace(options: BootstrapOptions): void {
  const { workspacePath, identity, contextTreePath, serverUrl, chatId } = options;
  const agentDir = join(workspacePath, ".agent");
  const contextDir = join(agentDir, "context");

  // Clear stale context before repopulating (prevents serving outdated profile)
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

  // 2. Write agent profile from Hub identity (if available)
  if (identity.profile) {
    writeFileSync(join(contextDir, "self.md"), identity.profile, "utf-8");
  }

  // 3. Copy organizational context from Context Tree (if available)
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

  // 4. Write tools.md (static SDK reference)
  writeFileSync(join(agentDir, "tools.md"), generateToolsDoc(), "utf-8");
}

function generateToolsDoc(): string {
  return `# Agent Hub SDK

## How You Communicate

You are running inside **Agent Hub**, a messaging platform for agent teams.

- Messages from other team members arrive as your prompt input
- Each message includes a \`[From: sender-id]\` header so you know who sent it
- **Your final text response is automatically delivered** to the chat — just respond normally
- For **proactive communication** (sending to other agents, other chats, or structured data),
  use the curl API endpoints below
- **Use your judgment about when to respond.** Not every message requires a reply.
  Your role and responsibilities (defined in your profile above) guide your behavior

## Environment Variables

These are injected automatically when the agent process starts:

| Variable | Description |
|----------|-------------|
| \`FIRST_TREE_HUB_SERVER_URL\` | Server address for API calls |
| \`FIRST_TREE_HUB_AGENT_TOKEN\` | Bearer token for authentication |
| \`FIRST_TREE_HUB_CHAT_ID\` | Current chat context ID |
| \`FIRST_TREE_HUB_AGENT_ID\` | Your agent ID |

## Sending Messages

Use curl or any HTTP client with the bearer token:

\`\`\`bash
# Reply in current chat
curl -X POST "$FIRST_TREE_HUB_SERVER_URL/api/v1/agent/chats/$FIRST_TREE_HUB_CHAT_ID/messages" \\
  -H "Authorization: Bearer $FIRST_TREE_HUB_AGENT_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"format": "text", "content": "your message"}'

# Send to another agent directly
curl -X POST "$FIRST_TREE_HUB_SERVER_URL/api/v1/agent/agents/{agentId}/messages" \\
  -H "Authorization: Bearer $FIRST_TREE_HUB_AGENT_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"format": "text", "content": "your message"}'
\`\`\`
`;
}
