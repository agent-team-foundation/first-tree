import { execSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getClientConfig } from "@first-tree-hub/shared/config";

/**
 * Get the current GitHub username from `gh auth status`.
 */
export function getGitHubUsername(): string {
  try {
    const output = execSync("gh api /user --jq .login", { encoding: "utf-8" }).trim();
    if (!output) throw new Error("Empty response");
    return output;
  } catch {
    throw new Error(
      "Failed to get GitHub username. Ensure `gh` CLI is installed and authenticated:\n" + "  gh auth login",
    );
  }
}

/**
 * Get the GitHub auth token from `gh auth token`.
 */
export function getGitHubToken(): string {
  try {
    const output = execSync("gh auth token", { encoding: "utf-8" }).trim();
    if (!output) throw new Error("Empty response");
    return output;
  } catch {
    throw new Error(
      "Failed to get GitHub token. Ensure `gh` CLI is installed and authenticated:\n" + "  gh auth login",
    );
  }
}

/**
 * Resolve Hub server URL from flag, env, or config.
 */
export function resolveServerUrl(flagValue?: string): string {
  if (flagValue) return flagValue;
  if (process.env.FIRST_TREE_HUB_SERVER) return process.env.FIRST_TREE_HUB_SERVER;

  try {
    const config = getClientConfig();
    if (config.server?.url) return config.server.url;
  } catch {
    // Config not available
  }

  throw new Error(
    "Server URL not configured.\n" +
      "  Provide via: --server <url>, FIRST_TREE_HUB_SERVER env var, or\n" +
      "  first-tree-hub config set -c server.url <url>",
  );
}

/**
 * Bootstrap a token for an agent using GitHub identity.
 */
export async function bootstrapToken(
  serverUrl: string,
  agentId: string,
  options: { saveTo?: string } = {},
): Promise<{ token: string; agentId: string }> {
  const githubToken = getGitHubToken();

  const res = await fetch(`${serverUrl}/api/v1/bootstrap/${encodeURIComponent(agentId)}/token`, {
    method: "POST",
    headers: {
      "X-GitHub-Token": githubToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: "bootstrap" }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    const msg = body.error ?? `HTTP ${res.status}`;
    throw new Error(`Bootstrap failed for "${agentId}": ${msg}`);
  }

  const data = (await res.json()) as { token: string; agentId: string };

  // Save token to agent config if requested
  if (options.saveTo === "agent" || !options.saveTo) {
    const configDir = join(homedir(), ".first-tree-hub", "agents", agentId);
    const configPath = `${configDir}/agent.yaml`;
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(configPath, `token: "${data.token}"\ntype: claude-code\n`, { mode: 0o600 });
    chmodSync(configDir, 0o700);
  } else if (options.saveTo) {
    mkdirSync(dirname(options.saveTo), { recursive: true });
    writeFileSync(options.saveTo, data.token, { mode: 0o600 });
  }

  return data;
}

/**
 * Resolve agent token from FIRST_TREE_HUB_TOKEN env var.
 * Throws if not set.
 */
export function resolveAgentToken(): string {
  const token = process.env.FIRST_TREE_HUB_TOKEN;
  if (!token) {
    throw new Error("FIRST_TREE_HUB_TOKEN environment variable is required.");
  }
  return token;
}

/**
 * Check if an agent exists and is synced.
 */
export async function checkBootstrapStatus(
  serverUrl: string,
  agentId: string,
): Promise<{ exists: boolean; status: string | null }> {
  const githubToken = getGitHubToken();

  const res = await fetch(`${serverUrl}/api/v1/bootstrap/${encodeURIComponent(agentId)}/status`, {
    headers: { "X-GitHub-Token": githubToken },
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }

  return (await res.json()) as { exists: boolean; status: string | null };
}
