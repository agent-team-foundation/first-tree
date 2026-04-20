import { readFileSync } from "node:fs";
import type { AgentRuntimeConfig, AgentRuntimeConfigPayload } from "@agent-team-foundation/first-tree-hub-shared";
import type { Command } from "commander";
import { fail, success } from "../cli/output.js";
import { ensureFreshAdminToken, resolveServerUrl } from "../core/bootstrap.js";

/**
 * Step 8: `first-tree-hub agent config ...` subcommands.
 *
 * Every command is a thin wrapper over the Admin HTTP API:
 *   GET    /api/v1/admin/agents/:id/config
 *   PATCH  /api/v1/admin/agents/:id/config
 *   POST   /api/v1/admin/agents/:id/config/dry-run
 *
 * Sensitive env values are returned masked from the server (***).
 */

type ResolvedAgent = { uuid: string; name: string | null; displayName: string | null };

async function resolveAgentRecord(serverUrl: string, adminToken: string, agentName: string): Promise<ResolvedAgent> {
  const res = await fetch(`${serverUrl}/api/v1/admin/agents?limit=100`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    fail("FETCH_ERROR", `Failed to list agents: ${res.status}`, 1);
  }
  const data = (await res.json()) as { items: ResolvedAgent[] };
  const found = data.items.find((a) => a.name === agentName || a.uuid === agentName);
  if (!found) {
    fail("NOT_FOUND", `Agent "${agentName}" not found`, 1);
  }
  return found;
}

async function adminFetch<T>(url: string, init: RequestInit & { adminToken: string }): Promise<T> {
  const { adminToken, headers, ...rest } = init;
  const res = await fetch(url, {
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

async function getCurrent(serverUrl: string, adminToken: string, agentId: string): Promise<AgentRuntimeConfig> {
  return adminFetch<AgentRuntimeConfig>(`${serverUrl}/api/v1/admin/agents/${agentId}/config`, {
    method: "GET",
    adminToken,
  });
}

async function patchConfig(
  serverUrl: string,
  adminToken: string,
  agentId: string,
  expectedVersion: number,
  patch: Partial<AgentRuntimeConfigPayload>,
): Promise<AgentRuntimeConfig> {
  return adminFetch<AgentRuntimeConfig>(`${serverUrl}/api/v1/admin/agents/${agentId}/config`, {
    method: "PATCH",
    adminToken,
    body: JSON.stringify({ expectedVersion, payload: patch }),
  });
}

function printConfig(cfg: AgentRuntimeConfig): void {
  process.stdout.write(`Agent: ${cfg.agentId}\n`);
  process.stdout.write(`Version: ${cfg.version} (updated ${cfg.updatedAt} by ${cfg.updatedBy})\n`);
  process.stdout.write(`\nModel:    ${cfg.payload.model || "(unset)"}\n`);
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

export function registerAgentConfigCommands(parent: Command): void {
  const config = parent.command("config").description("Manage agent runtime configuration (Step 8)");

  config
    .command("get <agent>")
    .description("Print the current runtime config for an agent")
    .action(async (agentName: string) => {
      const serverUrl = resolveServerUrl(process.env.FIRST_TREE_HUB_SERVER_URL);
      const adminToken = await ensureFreshAdminToken();
      const { uuid } = await resolveAgentRecord(serverUrl, adminToken, agentName);
      const cfg = await getCurrent(serverUrl, adminToken, uuid);
      printConfig(cfg);
    });

  config
    .command("set-model <agent> <model>")
    .description("Replace the model field (e.g. claude-opus-4-7)")
    .action(async (agentName: string, model: string) => {
      const serverUrl = resolveServerUrl(process.env.FIRST_TREE_HUB_SERVER_URL);
      const adminToken = await ensureFreshAdminToken();
      const { uuid } = await resolveAgentRecord(serverUrl, adminToken, agentName);
      const current = await getCurrent(serverUrl, adminToken, uuid);
      const updated = await patchConfig(serverUrl, adminToken, uuid, current.version, { model });
      success({ agentId: updated.agentId, version: updated.version, model: updated.payload.model });
    });

  config
    .command("append-prompt <agent>")
    .description("Replace the systemPrompt append text — reads from -f file or stdin")
    .option("-f, --file <path>", "Read prompt text from this file")
    .action(async (agentName: string, opts: { file?: string }) => {
      const serverUrl = resolveServerUrl(process.env.FIRST_TREE_HUB_SERVER_URL);
      const adminToken = await ensureFreshAdminToken();
      const { uuid } = await resolveAgentRecord(serverUrl, adminToken, agentName);
      let text: string;
      if (opts.file) {
        text = readFileSync(opts.file, "utf-8");
      } else if (!process.stdin.isTTY) {
        text = await new Promise<string>((resolve, reject) => {
          const chunks: Buffer[] = [];
          process.stdin.on("data", (c: Buffer) => chunks.push(c));
          process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
          process.stdin.on("error", reject);
        });
      } else {
        fail("MISSING_INPUT", "Provide -f <file> or pipe prompt text via stdin", 2);
      }
      const current = await getCurrent(serverUrl, adminToken, uuid);
      const updated = await patchConfig(serverUrl, adminToken, uuid, current.version, {
        prompt: { append: text },
      });
      success({ agentId: updated.agentId, version: updated.version, append_length: text.length });
    });

  config
    .command("add-mcp <agent>")
    .description("Add or replace an MCP server (replace-by-name semantics)")
    .requiredOption("--name <name>", "MCP server name")
    .requiredOption("--transport <transport>", "stdio | http | sse")
    .option("--command <command>", "stdio command")
    .option("--args <args...>", "stdio command args")
    .option("--url <url>", "http/sse URL")
    .action(
      async (
        agentName: string,
        opts: { name: string; transport: string; command?: string; args?: string[]; url?: string },
      ) => {
        const serverUrl = resolveServerUrl(process.env.FIRST_TREE_HUB_SERVER_URL);
        const adminToken = await ensureFreshAdminToken();
        const { uuid } = await resolveAgentRecord(serverUrl, adminToken, agentName);
        const current = await getCurrent(serverUrl, adminToken, uuid);

        let server: AgentRuntimeConfigPayload["mcpServers"][number];
        if (opts.transport === "stdio") {
          if (!opts.command) fail("MISSING_COMMAND", "stdio transport requires --command", 2);
          server = { name: opts.name, transport: "stdio", command: opts.command, args: opts.args };
        } else if (opts.transport === "http" || opts.transport === "sse") {
          if (!opts.url) fail("MISSING_URL", `${opts.transport} transport requires --url`, 2);
          server = { name: opts.name, transport: opts.transport, url: opts.url };
        } else {
          fail("BAD_TRANSPORT", `transport must be stdio|http|sse, got ${opts.transport}`, 2);
        }

        const remaining = current.payload.mcpServers.filter((s) => s.name !== opts.name);
        const updated = await patchConfig(serverUrl, adminToken, uuid, current.version, {
          mcpServers: [...remaining, server],
        });
        success({ agentId: updated.agentId, version: updated.version, mcpServer: opts.name });
      },
    );

  config
    .command("set-env <agent> <kv>")
    .description("Set an env variable: KEY=VALUE. Use --sensitive for secrets.")
    .option("--sensitive", "Mark this value as sensitive (encrypted at rest, masked in echo)")
    .action(async (agentName: string, kv: string, opts: { sensitive?: boolean }) => {
      const serverUrl = resolveServerUrl(process.env.FIRST_TREE_HUB_SERVER_URL);
      const adminToken = await ensureFreshAdminToken();
      const { uuid } = await resolveAgentRecord(serverUrl, adminToken, agentName);
      const eqIdx = kv.indexOf("=");
      if (eqIdx <= 0) fail("BAD_KV", "Expected KEY=VALUE", 2);
      const key = kv.slice(0, eqIdx);
      const value = kv.slice(eqIdx + 1);
      const current = await getCurrent(serverUrl, adminToken, uuid);
      const remaining = current.payload.env.filter((e) => e.key !== key);
      const updated = await patchConfig(serverUrl, adminToken, uuid, current.version, {
        env: [...remaining, { key, value, sensitive: opts.sensitive ?? false }],
      });
      success({ agentId: updated.agentId, version: updated.version, env: key });
    });

  config
    .command("add-repo <agent> <url>")
    .description("Add a Git repo to the agent's worktree set")
    .option("--ref <ref>", "branch / tag / commit (defaults to repo HEAD)")
    .option("--path <path>", "local path relative to session cwd")
    .action(async (agentName: string, url: string, opts: { ref?: string; path?: string }) => {
      const serverUrl = resolveServerUrl(process.env.FIRST_TREE_HUB_SERVER_URL);
      const adminToken = await ensureFreshAdminToken();
      const { uuid } = await resolveAgentRecord(serverUrl, adminToken, agentName);
      const current = await getCurrent(serverUrl, adminToken, uuid);
      const remaining = current.payload.gitRepos.filter((r) => r.url !== url);
      const updated = await patchConfig(serverUrl, adminToken, uuid, current.version, {
        gitRepos: [...remaining, { url, ref: opts.ref, localPath: opts.path }],
      });
      success({ agentId: updated.agentId, version: updated.version, repo: url });
    });

  config
    .command("dry-run <agent>")
    .description("Validate a JSON patch and print the diff without persisting")
    .requiredOption("-f, --file <path>", "JSON file with the partial payload to apply")
    .action(async (agentName: string, opts: { file: string }) => {
      const serverUrl = resolveServerUrl(process.env.FIRST_TREE_HUB_SERVER_URL);
      const adminToken = await ensureFreshAdminToken();
      const { uuid } = await resolveAgentRecord(serverUrl, adminToken, agentName);
      const patch = JSON.parse(readFileSync(opts.file, "utf-8")) as Partial<AgentRuntimeConfigPayload>;
      const result = await adminFetch<{
        current: AgentRuntimeConfig;
        next: AgentRuntimeConfigPayload;
        diff: Array<{ path: string; op: string; before?: unknown; after?: unknown }>;
      }>(`${serverUrl}/api/v1/admin/agents/${uuid}/config/dry-run`, {
        method: "POST",
        adminToken,
        body: JSON.stringify({ payload: patch }),
      });
      process.stdout.write(`Diff (${result.diff.length} change${result.diff.length === 1 ? "" : "s"}):\n`);
      for (const d of result.diff) {
        process.stdout.write(`  ${d.op} ${d.path}\n`);
      }
    });
}
