import type {
  AgentResourcesOutput,
  AgentRuntimeConfig,
  AgentRuntimeConfigPatch,
  UpdateAgentResources,
} from "@first-tree/shared";
import { fail } from "../../../../cli/output.js";
import { cliFetch } from "../../../../core/cli-fetch.js";
import { type ResolvedAgent, resolveAgent } from "../../../_shared/resolve-agent.js";

/**
 * Shared helpers for the `agent config ...` subcommands. Every command is a
 * thin wrapper over the resource-scoped HTTP API:
 *
 *     GET    /api/v1/agents/:id/config
 *     PATCH  /api/v1/agents/:id/config
 *     POST   /api/v1/agents/:id/config/dry-run
 *
 * Sensitive env values are returned masked from the server (***).
 */

export type { ResolvedAgent };

export async function resolveAgentRecord(
  serverUrl: string,
  adminToken: string,
  agentName: string,
): Promise<ResolvedAgent> {
  return resolveAgent(serverUrl, adminToken, agentName);
}

export async function adminFetch<T>(url: string, init: RequestInit & { adminToken: string }): Promise<T> {
  const { adminToken, headers, ...rest } = init;
  const res = await cliFetch(url, {
    ...rest,
    headers: {
      Authorization: `Bearer ${adminToken}`,
      ...(rest.body ? { "Content-Type": "application/json" } : {}),
      ...(headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text();
    fail(`HTTP_${res.status}`, text || res.statusText, res.status === 401 ? 3 : 1);
  }
  return (await res.json()) as T;
}

export async function getCurrent(serverUrl: string, adminToken: string, agentId: string): Promise<AgentRuntimeConfig> {
  return adminFetch<AgentRuntimeConfig>(`${serverUrl}/api/v1/agents/${agentId}/config`, {
    method: "GET",
    adminToken,
  });
}

export async function patchConfig(
  serverUrl: string,
  adminToken: string,
  agentId: string,
  expectedVersion: number,
  patch: AgentRuntimeConfigPatch,
): Promise<AgentRuntimeConfig> {
  return adminFetch<AgentRuntimeConfig>(`${serverUrl}/api/v1/agents/${agentId}/config`, {
    method: "PATCH",
    adminToken,
    body: JSON.stringify({ expectedVersion, payload: patch }),
  });
}

export async function getAgentResources(
  serverUrl: string,
  adminToken: string,
  agentId: string,
): Promise<AgentResourcesOutput> {
  return adminFetch<AgentResourcesOutput>(`${serverUrl}/api/v1/agents/${agentId}/resources`, {
    method: "GET",
    adminToken,
  });
}

export async function patchAgentResources(
  serverUrl: string,
  adminToken: string,
  agentId: string,
  body: UpdateAgentResources,
): Promise<AgentResourcesOutput> {
  return adminFetch<AgentResourcesOutput>(`${serverUrl}/api/v1/agents/${agentId}/resources`, {
    method: "PATCH",
    adminToken,
    body: JSON.stringify(body),
  });
}

export function printConfig(cfg: AgentRuntimeConfig): void {
  process.stdout.write(`Agent: ${cfg.agentId}\n`);
  process.stdout.write(`Version: ${cfg.version} (updated ${cfg.updatedAt} by ${cfg.updatedBy})\n`);
  process.stdout.write(`\nModel:    ${cfg.payload.model || "(unset)"}\n`);
  process.stdout.write(`Reasoning effort: ${cfg.payload.reasoningEffort || "(unset — inherits local effortLevel)"}\n`);
  process.stdout.write(`Prompt append: ${cfg.payload.prompt.append ? "(set)" : "(empty)"}\n`);
  if (cfg.payload.prompt.append) process.stdout.write(`  > ${cfg.payload.prompt.append.replace(/\n/g, "\n  > ")}\n`);
  process.stdout.write(`\nMCP servers (${cfg.payload.mcpServers.length}):\n`);
  for (const s of cfg.payload.mcpServers) {
    process.stdout.write(`  - ${s.name} [${s.transport}]\n`);
  }
  process.stdout.write(`\nEnv (${cfg.payload.env.length}):\n`);
  for (const e of cfg.payload.env) {
    process.stdout.write(`  - ${e.key}=${e.value} ${e.sensitive ? "(sensitive)" : ""}\n`);
  }
  process.stdout.write(`\nGit repos (${cfg.payload.gitRepos.length}):\n`);
  for (const r of cfg.payload.gitRepos) {
    const ref = r.ref ? `@${r.ref}` : "";
    const path = r.localPath ? ` → ${r.localPath}` : "";
    process.stdout.write(`  - ${r.url}${ref}${path}\n`);
  }
}
