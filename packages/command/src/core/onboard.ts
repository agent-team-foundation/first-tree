import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG_DIR, DEFAULT_HOME_DIR, setConfigValue } from "@first-tree-hub/shared/config";
import { bootstrapToken, checkBootstrapStatus, getGitHubUsername, resolveServerUrl } from "./bootstrap.js";

// ── Types ────────────────────────────────────────────────────────────

type OnboardArgs = {
  id: string;
  type: "human" | "personal_assistant" | "autonomous_agent";
  role: string;
  domains: string;
  displayName?: string;
  assistant?: string;
  delegateMention?: string;
  server?: string;
  feishuBotAppId?: string;
  feishuBotAppSecret?: string;
  feishuSearch?: string;
  feishuUserSelect?: number;
  check?: boolean;
  continue?: boolean;
};

type CheckItem = {
  key: string;
  label: string;
  status: "ok" | "missing_required" | "missing_optional" | "warning" | "error";
  value?: string;
  hint?: string;
};

export const STATE_FILE = join(DEFAULT_HOME_DIR, ".onboard-state.json");

/** Save current onboard args to state file for resume. */
export function saveOnboardState(args: Record<string, unknown>): void {
  mkdirSync(DEFAULT_HOME_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ args }, null, 2));
}

/** Load saved onboard args from state file. */
export function loadOnboardState(): Record<string, unknown> | null {
  try {
    const data = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as { args: Record<string, unknown> };
    return data.args;
  } catch {
    return null;
  }
}

// ── Check mode ───────────────────────────────────────────────────────

export async function onboardCheck(args: OnboardArgs): Promise<CheckItem[]> {
  const items: CheckItem[] = [];

  // GitHub CLI — check first, everything else depends on it
  let ghUsername: string | null = null;
  try {
    ghUsername = getGitHubUsername();
    items.push({ key: "github_cli", label: "GitHub CLI", status: "ok", value: `authenticated as ${ghUsername}` });
  } catch {
    items.push({
      key: "github_cli",
      label: "GitHub CLI",
      status: "missing_required",
      hint: "Install and authenticate: gh auth login",
    });
  }

  // Server URL
  try {
    const serverUrl = resolveServerUrl(args.server);
    items.push({ key: "server", label: "Server URL", status: "ok", value: serverUrl });

    // Check server reachable
    try {
      const res = await fetch(`${serverUrl}/api/v1/health`);
      items.push({
        key: "server_reachable",
        label: "Server reachable",
        status: res.ok ? "ok" : "error",
        value: res.ok ? "yes" : `HTTP ${res.status}`,
      });
    } catch {
      items.push({ key: "server_reachable", label: "Server reachable", status: "error", value: "no" });
    }
  } catch {
    items.push({
      key: "server",
      label: "Server URL",
      status: "missing_required",
      hint: "--server <url> or FIRST_TREE_HUB_SERVER",
    });
  }

  // Context Tree repo (auto-managed at $FIRST_TREE_HUB_HOME/context-tree/)
  const repoPath = await resolveContextTreeRepo(args.server);
  if (repoPath) {
    items.push({ key: "repo", label: "Context Tree repo", status: "ok", value: repoPath });
  } else {
    const serverAvailable = items.some((i) => i.key === "server" && i.status === "ok");
    items.push({
      key: "repo",
      label: "Context Tree repo",
      status: "missing_required",
      hint: serverAvailable
        ? "auto-clone failed (check server Context Tree config and gh auth)"
        : "configure --server first (repo will be auto-cloned from server)",
    });
  }

  // Member info
  items.push(
    args.id
      ? { key: "id", label: "id", status: "ok", value: args.id }
      : { key: "id", label: "id", status: "missing_required", hint: "Member directory name" },
  );

  items.push(
    args.type
      ? { key: "type", label: "type", status: "ok", value: args.type }
      : {
          key: "type",
          label: "type",
          status: "missing_required",
          hint: "human | personal_assistant | autonomous_agent",
        },
  );

  items.push(
    args.role
      ? { key: "role", label: "role", status: "ok", value: args.role }
      : { key: "role", label: "role", status: "missing_required", hint: 'e.g. "Engineer"' },
  );

  items.push(
    args.domains
      ? { key: "domains", label: "domains", status: "ok", value: args.domains }
      : { key: "domains", label: "domains", status: "missing_required", hint: 'Comma-separated, e.g. "backend,infra"' },
  );

  items.push(
    args.displayName
      ? { key: "display_name", label: "display-name", status: "ok", value: args.displayName }
      : {
          key: "display_name",
          label: "display-name",
          status: "missing_optional",
          hint: `defaults to "${args.id ?? ""}"`,
        },
  );

  // Assistant is only applicable for human agents
  if (args.type === "human") {
    items.push(
      args.assistant
        ? { key: "assistant", label: "assistant", status: "ok", value: args.assistant }
        : {
            key: "assistant",
            label: "assistant",
            status: "missing_optional",
            hint: "Also create a personal_assistant",
          },
    );
  }

  // Feishu bot binding is only applicable for non-human agents
  if (args.type !== "human") {
    items.push(
      args.feishuBotAppId
        ? { key: "feishu_bot", label: "feishu-bot-app-id", status: "ok", value: args.feishuBotAppId }
        : {
            key: "feishu_bot",
            label: "feishu-bot-app-id",
            status: "missing_optional",
            hint: "Feishu bot App ID for this agent",
          },
    );
  }

  // Check conflicts — distinguish between committed (real conflict) and uncommitted (resume)
  if (args.id && repoPath) {
    const memberDir = join(repoPath, "members", args.id);
    if (existsSync(memberDir)) {
      // Check if it's tracked by git (committed to current branch) or just local leftover
      try {
        execSync(`git ls-files --error-unmatch members/${args.id}/NODE.md`, {
          cwd: repoPath,
          stdio: "pipe",
        });
        // Tracked = real conflict (already committed)
        items.push({
          key: "conflict",
          label: `ID "${args.id}" availability`,
          status: "warning",
          value: "already exists (will overwrite)",
        });
      } catch {
        // Not tracked = leftover from previous failed run, safe to overwrite
        items.push({
          key: "conflict",
          label: `ID "${args.id}" availability`,
          status: "ok",
          value: "resuming (local files from previous run)",
        });
      }
    } else {
      items.push({ key: "conflict", label: `ID "${args.id}" availability`, status: "ok", value: "available" });
    }
  }

  return items;
}

export function formatCheckReport(items: CheckItem[]): string {
  const lines: string[] = [];
  for (const item of items) {
    const icon =
      item.status === "ok"
        ? "✅"
        : item.status === "missing_required"
          ? "❌"
          : item.status === "error"
            ? "❌"
            : item.status === "warning"
              ? "⚠️"
              : "⬜";
    const valueStr = item.value ? `  ${item.value}` : "";
    const hintStr = item.hint ? `  (${item.hint})` : "";
    lines.push(`  ${icon} ${item.label.padEnd(20)}${valueStr}${hintStr}`);
  }
  return lines.join("\n");
}

// ── Phase 1: Create Context Tree PR ──────────────────────────────────

export async function onboardCreate(args: OnboardArgs): Promise<{ prUrl: string }> {
  const repoPath = await resolveContextTreeRepo(args.server);
  if (!repoPath)
    throw new Error("Context Tree repo not available. Ensure --server is configured and the server is running.");

  // Autonomous agents and personal assistants cannot have a personal assistant
  if (args.assistant && args.type !== "human") {
    throw new Error(`--assistant is only valid for human agents, not ${args.type}`);
  }

  const ghUsername = getGitHubUsername();

  // For human type, github field = current gh user by default
  const githubField = args.type === "human" ? ghUsername : null;

  // Check if human member already exists (committed to git)
  const humanNodePath = join(repoPath, "members", args.id, "NODE.md");
  const humanExists = existsSync(humanNodePath) && isTrackedByGit(repoPath, join("members", args.id, "NODE.md"));

  if (humanExists) {
    process.stderr.write(`Member "${args.id}" already exists, skipping NODE.md creation.\n`);

    // If adding assistant, update delegate_mention in existing NODE.md
    if (args.assistant) {
      const existingContent = readFileSync(humanNodePath, "utf-8");
      if (!existingContent.includes("delegate_mention")) {
        // Add delegate_mention to frontmatter
        const updated = existingContent.replace(/^(---\n[\s\S]*?)(---)/m, `$1delegate_mention: ${args.assistant}\n$2`);
        writeFileSync(humanNodePath, updated);
        process.stderr.write(`Updated delegate_mention → ${args.assistant}\n`);
      }
    }
  } else {
    // Create member NODE.md
    createMemberNodeMd(repoPath, {
      id: args.id,
      type: args.type,
      displayName: args.displayName ?? args.id,
      role: args.role,
      domains: args.domains.split(",").map((d) => d.trim()),
      owner: ghUsername,
      github: githubField,
      delegateMention: args.assistant ?? args.delegateMention ?? null,
    });
  }

  // Create assistant NODE.md as subdirectory under human
  if (args.assistant) {
    const assistantNodePath = join(repoPath, "members", args.id, args.assistant, "NODE.md");
    if (
      existsSync(assistantNodePath) &&
      isTrackedByGit(repoPath, join("members", args.id, args.assistant, "NODE.md"))
    ) {
      process.stderr.write(`Assistant "${args.assistant}" already exists, skipping.\n`);
    } else {
      createMemberNodeMd(repoPath, {
        parentPath: join("members", args.id),
        id: args.assistant,
        type: "personal_assistant",
        displayName: args.assistant,
        role: `Personal Assistant to ${args.id}`,
        domains: ["message triage", "task coordination"],
        owner: ghUsername,
        github: null,
        delegateMention: null,
      });
    }
  }

  // Verify the whole tree (same check CI will run)
  try {
    execSync("npx -y first-tree verify", { cwd: repoPath, stdio: "pipe" });
  } catch (err) {
    const stderr = err instanceof Error && "stderr" in err ? (err as { stderr: Buffer }).stderr.toString() : "";
    const stdout = err instanceof Error && "stdout" in err ? (err as { stdout: Buffer }).stdout.toString() : "";
    const output = stderr || stdout || String(err);

    // Check if it's a repo initialization issue vs member validation issue
    if (output.includes("VERSION") || output.includes("AGENT.md") || output.includes("Root NODE.md")) {
      throw new Error(
        "Context Tree repo is not properly initialized.\n" +
          "Run 'context-tree init' in the repo first, or see:\n" +
          "  https://github.com/agent-team-foundation/first-tree\n\n" +
          output,
      );
    }
    throw new Error(`Verification failed:\n${output}`);
  }

  // Git operations — ensure clean branch
  const baseBranch = `onboard/${args.id}`;
  let branch = baseBranch;

  // Check if branch already exists (local or remote)
  const branchExists = (name: string): boolean => {
    try {
      execSync(`git rev-parse --verify ${name}`, { cwd: repoPath, stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  };

  if (branchExists(branch)) {
    // Try with timestamp suffix
    const suffix = Date.now().toString(36);
    branch = `${baseBranch}-${suffix}`;
  }

  // Ensure we're on main/default branch before creating new branch
  try {
    execSync("git checkout main", { cwd: repoPath, stdio: "pipe" });
  } catch {
    try {
      execSync("git checkout master", { cwd: repoPath, stdio: "pipe" });
    } catch {
      // Stay on current branch
    }
  }

  execSync(`git checkout -b ${branch}`, { cwd: repoPath, stdio: "pipe" });

  // git add the human member dir (includes assistant subdirectory if created)
  execSync(`git add members/${args.id}`, { cwd: repoPath, stdio: "pipe" });

  const commitMsg = args.assistant ? `feat: onboard ${args.id} + ${args.assistant}` : `feat: onboard ${args.id}`;
  execFileSync("git", ["commit", "-m", commitMsg], { cwd: repoPath, stdio: "pipe" });

  // Push with gh token auth — inject token via temporary remote URL to keep it off the command line
  const pushToken = execSync("gh auth token", { encoding: "utf-8", stdio: "pipe" }).trim();
  const cleanRemote = execSync("git remote get-url origin", { cwd: repoPath, encoding: "utf-8", stdio: "pipe" }).trim();
  const authedRemote = cleanRemote.replace("https://github.com/", `https://x-access-token:${pushToken}@github.com/`);
  execSync(`git remote set-url origin "${authedRemote}"`, { cwd: repoPath, stdio: "pipe" });
  try {
    execSync(`git push -u origin ${branch}`, { cwd: repoPath, stdio: "pipe" });
  } finally {
    execSync(`git remote set-url origin "${cleanRemote}"`, { cwd: repoPath, stdio: "pipe" });
  }

  // Create PR
  const prTitle = args.assistant ? `Onboard ${args.id} + assistant` : `Onboard ${args.id}`;
  const prOutput = execSync(`gh pr create --title "${prTitle}" --body "Automated onboard via first-tree-hub CLI"`, {
    cwd: repoPath,
    encoding: "utf-8",
  }).trim();

  // Save state for --continue
  const state = { args, branch, prUrl: prOutput };
  mkdirSync(DEFAULT_HOME_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  return { prUrl: prOutput };
}

// ── Phase 2: Setup after PR merge ────────────────────────────────────

export async function onboardContinue(args: OnboardArgs): Promise<void> {
  // Load saved state
  let state: { args: OnboardArgs } | null = null;
  try {
    state = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as { args: OnboardArgs };
  } catch {
    // No state file, use current args
  }

  if (!state && !args.id) {
    throw new Error("No onboard in progress. Run 'first-tree-hub onboard' first to start a new onboard.");
  }

  const mergedArgs = { ...state?.args, ...stripUndefined(args) };
  const serverUrl = resolveServerUrl(mergedArgs.server).replace(/\/+$/, "");
  // For human+assistant, bootstrap the assistant (it's the one that runs as a client).
  // For autonomous_agent or standalone personal_assistant, bootstrap the agent itself.
  const agentToBootstrap = mergedArgs.assistant ?? mergedArgs.id;

  if (!agentToBootstrap)
    throw new Error("Cannot determine which agent to bootstrap. Provide --id or run onboard first.");
  if (!mergedArgs.id) throw new Error("Cannot determine member ID. Provide --id or run onboard first.");

  // 1. Wait for sync
  process.stderr.write(`Waiting for agent "${agentToBootstrap}" to be synced...\n`);
  let synced = false;
  for (let i = 0; i < 30; i++) {
    try {
      const status = await checkBootstrapStatus(serverUrl, agentToBootstrap);
      if (status.exists && status.status === "active") {
        synced = true;
        break;
      }
    } catch (err) {
      // Log first error for debugging, silently retry for others
      if (i === 0) {
        process.stderr.write(`  (check failed: ${err instanceof Error ? err.message : String(err)})\n`);
      }
    }
    await sleep(2000);
  }
  if (!synced) {
    throw new Error(`Agent "${agentToBootstrap}" not found after 60s. Trigger sync manually or wait for auto-sync.`);
  }

  // 2. Bootstrap token
  process.stderr.write(`Bootstrapping token for "${agentToBootstrap}"...\n`);
  let token: string;
  try {
    const result = await bootstrapToken(serverUrl, agentToBootstrap, { saveTo: "agent" });
    token = result.token;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already has") || msg.includes("409")) {
      throw new Error(
        `Agent "${agentToBootstrap}" already has an active token.\n` +
          "Ask an admin to revoke the existing token in the Web UI, then re-run:\n" +
          "  first-tree-hub onboard --continue",
      );
    }
    throw err;
  }
  process.stderr.write(`Token saved to ${DEFAULT_HOME_DIR}/config/agents/${agentToBootstrap}/agent.yaml\n`);

  // 3. Bind Feishu bot (if requested)
  if (mergedArgs.feishuBotAppId && mergedArgs.feishuBotAppSecret) {
    const { bindFeishuBot } = await import("./feishu.js");
    process.stderr.write("Binding Feishu bot...\n");
    await bindFeishuBot(serverUrl, token, mergedArgs.feishuBotAppId, mergedArgs.feishuBotAppSecret);
    process.stderr.write("Feishu bot bound.\n");
  }

  // Clean up state file
  try {
    const { unlinkSync } = await import("node:fs");
    unlinkSync(STATE_FILE);
  } catch {
    // Ignore
  }

  // Summary
  const typeLabel =
    mergedArgs.type === "human" ? "Human" : mergedArgs.type === "autonomous_agent" ? "Agent" : "Assistant";
  process.stderr.write("\n✅ Onboard complete!\n\n");
  process.stderr.write(`  ${typeLabel}:${" ".repeat(Math.max(1, 10 - typeLabel.length))}${mergedArgs.id}\n`);
  if (mergedArgs.assistant) {
    process.stderr.write(`  Assistant: ${mergedArgs.assistant}\n`);
  }
  process.stderr.write(`  Token:     ${DEFAULT_HOME_DIR}/config/agents/${agentToBootstrap}/agent.yaml\n`);
  if (mergedArgs.feishuBotAppId) {
    process.stderr.write(`  Feishu:    bot bound (${mergedArgs.feishuBotAppId})\n`);
  }

  // 4. Auto-configure client config (server URL) so `client start` works zero-config
  const clientConfigPath = join(DEFAULT_CONFIG_DIR, "client.yaml");
  setConfigValue(clientConfigPath, "server.url", serverUrl);

  // Feishu user binding hint (show for all human agents)
  if (mergedArgs.type === "human") {
    process.stderr.write("\n  Next step — bind your Feishu account:\n");
    process.stderr.write(`    Send this message to the bot in Feishu:  /bind ${mergedArgs.id}\n`);
    if (!mergedArgs.feishuBotAppId) {
      process.stderr.write("    (requires a Feishu bot to be configured in the system)\n");
    }
  }

  // Start hint
  process.stderr.write("\n  Start the agent:\n");
  process.stderr.write("    first-tree-hub client start\n");

  process.stderr.write("\n");
}

// ── Helpers ──────────────────────────────────────────────────────────

function createMemberNodeMd(
  repoPath: string,
  data: {
    parentPath?: string;
    id: string;
    type: string;
    displayName: string;
    role: string;
    domains: string[];
    owner: string;
    github: string | null;
    delegateMention: string | null;
  },
): void {
  const base = data.parentPath ?? "members";
  const memberDir = join(repoPath, base, data.id);
  mkdirSync(memberDir, { recursive: true });

  const domainsList = data.domains.map((d) => `  - "${d}"`).join("\n");
  const githubLine = data.github ? `\ngithub: ${data.github}` : "";
  // delegate_mention is only meaningful for human agents (points to their PA)
  const delegateLine =
    data.delegateMention && data.type === "human" ? `\ndelegate_mention: ${data.delegateMention}` : "";

  // Type-specific body sections
  const bodySections =
    data.type === "autonomous_agent"
      ? `## About

## Capabilities

## Current Focus
`
      : `## About

## Current Focus
`;

  const content = `---
title: "${data.displayName}"
owners: [${data.owner}]
type: ${data.type}
role: "${data.role}"
domains:
${domainsList}${githubLine}${delegateLine}
---

# ${data.displayName}

${bodySections}`;

  writeFileSync(join(memberDir, "NODE.md"), content);
}

function isTrackedByGit(repoPath: string, filePath: string): boolean {
  try {
    execSync(`git ls-files --error-unmatch ${filePath}`, { cwd: repoPath, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const CONTEXT_TREE_DIR = join(DEFAULT_HOME_DIR, "context-tree");

/**
 * Resolve Context Tree to a **local path** at $FIRST_TREE_HUB_HOME/context-tree/.
 *
 * Repo URL is obtained from the Hub server. The local clone is always
 * managed in the standard location — no custom paths allowed.
 */
async function resolveContextTreeRepo(serverUrl?: string): Promise<string | null> {
  // Get repo URL from server (the only source of truth)
  const repoUrl = await fetchRepoUrlFromServer(serverUrl);

  if (!repoUrl) return null;

  // Get gh token once for all git operations
  let ghToken: string;
  try {
    ghToken = execSync("gh auth token", { encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return null;
  }

  // Helper: set GIT_ASKPASS to inject token without modifying URLs
  const gitEnv = {
    ...process.env,
    GIT_ASKPASS: "echo",
    GIT_TERMINAL_PROMPT: "0",
    GH_TOKEN: ghToken,
    GITHUB_TOKEN: ghToken,
  };

  // Configure git to use gh token for github.com
  const gitConfigArgs = `-c url."https://x-access-token:${ghToken}@github.com/".insteadOf="https://github.com/"`;

  // Check if already cloned with matching remote
  if (existsSync(join(CONTEXT_TREE_DIR, ".git"))) {
    try {
      const remote = execSync("git remote get-url origin", {
        cwd: CONTEXT_TREE_DIR,
        encoding: "utf-8",
        stdio: "pipe",
      }).trim();
      if (remote.includes(repoUrl.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, ""))) {
        process.stderr.write("Updating Context Tree...\n");
        execSync("git checkout main 2>/dev/null || git checkout master", {
          cwd: CONTEXT_TREE_DIR,
          stdio: "pipe",
        });
        try {
          execSync(`git ${gitConfigArgs} pull --ff-only`, { cwd: CONTEXT_TREE_DIR, stdio: "pipe", env: gitEnv });
        } catch {
          // Pull failed, still usable
        }
        return CONTEXT_TREE_DIR;
      }
    } catch {
      // Can't read remote, re-clone
    }

    // Different repo or broken — delete and re-clone
    const safePrefix = DEFAULT_HOME_DIR;
    if (!CONTEXT_TREE_DIR.startsWith(safePrefix) || CONTEXT_TREE_DIR === safePrefix) {
      throw new Error(`Refusing to delete unsafe path: ${CONTEXT_TREE_DIR}`);
    }
    execSync(`rm -rf ${CONTEXT_TREE_DIR}`);
  }

  // Fresh clone
  try {
    process.stderr.write(`Cloning Context Tree to ${CONTEXT_TREE_DIR}...\n`);
    mkdirSync(DEFAULT_HOME_DIR, { recursive: true });
    execSync(`git ${gitConfigArgs} clone ${repoUrl} ${CONTEXT_TREE_DIR}`, { stdio: "pipe", env: gitEnv });
    return CONTEXT_TREE_DIR;
  } catch {
    return null;
  }
}

/** Query server for Context Tree repo URL. */
async function fetchRepoUrlFromServer(serverUrl?: string): Promise<string | null> {
  if (!serverUrl) {
    try {
      serverUrl = resolveServerUrl();
    } catch {
      return null;
    }
  }
  try {
    const url = `${serverUrl.replace(/\/+$/, "")}/api/v1/context-tree/info`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { repo?: string };
    return data.repo ?? null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}
