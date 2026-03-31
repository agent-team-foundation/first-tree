import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  repo?: string;
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

export const STATE_FILE = `${process.env.HOME ?? "~"}/.first-tree-hub/.onboard-state.json`;

/** Save current onboard args to state file for resume. */
export function saveOnboardState(args: Record<string, unknown>): void {
  const dir = `${process.env.HOME ?? "~"}/.first-tree-hub`;
  mkdirSync(dir, { recursive: true });
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

  // Environment
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

  // GitHub CLI
  try {
    const username = getGitHubUsername();
    items.push({ key: "github_cli", label: "GitHub CLI", status: "ok", value: `authenticated as ${username}` });
  } catch {
    items.push({
      key: "github_cli",
      label: "GitHub CLI",
      status: "missing_required",
      hint: "Install and authenticate: gh auth login",
    });
  }

  // Context Tree repo
  const repoPath = resolveContextTreeRepo(args.server, args.repo);
  const envRepoVal = args.repo ?? process.env.FIRST_TREE_HUB_CONTEXT_TREE_REPO;
  if (repoPath) {
    items.push({ key: "repo", label: "Context Tree repo", status: "ok", value: repoPath });
  } else if (envRepoVal && isUrl(envRepoVal)) {
    items.push({
      key: "repo",
      label: "Context Tree repo",
      status: "missing_required",
      hint: `URL detected (${envRepoVal}), need --repo <local-path> to a clone`,
    });
  } else {
    items.push({
      key: "repo",
      label: "Context Tree repo",
      status: "missing_required",
      hint: "--repo <path> or FIRST_TREE_HUB_CONTEXT_TREE_REPO",
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

  items.push(
    args.assistant
      ? { key: "assistant", label: "assistant", status: "ok", value: args.assistant }
      : { key: "assistant", label: "assistant", status: "missing_optional", hint: "Also create a personal_assistant" },
  );

  // Feishu (optional)
  items.push(
    args.feishuBotAppId
      ? { key: "feishu_bot", label: "feishu-bot-app-id", status: "ok", value: args.feishuBotAppId }
      : {
          key: "feishu_bot",
          label: "feishu-bot-app-id",
          status: "missing_optional",
          hint: "Feishu bot App ID for assistant",
        },
  );

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
  const repoPath = resolveContextTreeRepo(args.server, args.repo);
  if (!repoPath) throw new Error("Context Tree repo path not found. Provide --repo <path>.");

  const ghUsername = getGitHubUsername();

  // For human type, github field = current gh user by default
  const githubField = args.type === "human" ? ghUsername : null;

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

  // Create assistant NODE.md as subdirectory under human
  if (args.assistant) {
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
  execSync(`git commit -m "${commitMsg}"`, { cwd: repoPath, stdio: "pipe" });
  execSync(`git push -u origin ${branch}`, { cwd: repoPath, stdio: "pipe" });

  // Create PR
  const prTitle = args.assistant ? `Onboard ${args.id} + assistant` : `Onboard ${args.id}`;
  const prOutput = execSync(`gh pr create --title "${prTitle}" --body "Automated onboard via first-tree-hub CLI"`, {
    cwd: repoPath,
    encoding: "utf-8",
  }).trim();

  // Save state for --continue
  const state = { args, branch, prUrl: prOutput };
  mkdirSync(`${process.env.HOME ?? "~"}/.first-tree-hub`, { recursive: true });
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
  const { token } = await bootstrapToken(serverUrl, agentToBootstrap, { saveTo: "agent" });
  process.stderr.write(`Token saved to ~/.first-tree-hub/agents/${agentToBootstrap}/agent.yaml\n`);

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
  process.stderr.write("\n✅ Onboard complete!\n\n");
  process.stderr.write(`  Human:     ${mergedArgs.id}\n`);
  if (mergedArgs.assistant) {
    process.stderr.write(`  Assistant: ${mergedArgs.assistant}\n`);
  }
  process.stderr.write(`  Token:     ~/.first-tree-hub/agents/${agentToBootstrap}/agent.yaml\n`);
  if (mergedArgs.feishuBotAppId) {
    process.stderr.write(`  Feishu:    bot bound (${mergedArgs.feishuBotAppId})\n`);
  }
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
  const delegateLine = data.delegateMention ? `\ndelegate_mention: ${data.delegateMention}` : "";

  const content = `---
title: "${data.displayName}"
owners: [${data.owner}]
type: ${data.type}
role: "${data.role}"
domains:
${domainsList}${githubLine}${delegateLine}
---

# ${data.displayName}

## About

## Current Focus
`;

  writeFileSync(join(memberDir, "NODE.md"), content);
}

function isUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

/**
 * Resolve Context Tree to a **local path**.
 * - If --repo flag is a local path → use it
 * - If env var is a local path → use it
 * - If env var is a URL → try to find a local clone in common locations
 * - Otherwise → return null (caller should prompt)
 */
function resolveContextTreeRepo(_serverUrl?: string, repoFlag?: string): string | null {
  if (repoFlag && !isUrl(repoFlag)) return repoFlag;
  if (repoFlag && isUrl(repoFlag)) {
    return findLocalClone(repoFlag);
  }

  const envVal = process.env.FIRST_TREE_HUB_CONTEXT_TREE_REPO;
  if (envVal && !isUrl(envVal)) return envVal;
  if (envVal && isUrl(envVal)) {
    return findLocalClone(envVal);
  }

  return null;
}

/**
 * Try to find a local clone of a GitHub repo URL by checking common locations.
 */
function findLocalClone(repoUrl: string): string | null {
  // Extract repo name from URL: https://github.com/owner/repo → repo
  const match = /\/([^/]+?)(?:\.git)?$/.exec(repoUrl);
  if (!match?.[1]) return null;
  const repoName = match[1];

  // Check common locations relative to CWD and home
  const candidates = [
    join(process.cwd(), "..", repoName),
    join(process.env.HOME ?? "~", "dev", repoName),
    join(process.env.HOME ?? "~", repoName),
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, ".git"))) {
      return candidate;
    }
  }

  return null;
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
