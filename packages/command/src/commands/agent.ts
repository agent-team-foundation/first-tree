import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { MessageFormat } from "@agent-team-foundation/first-tree-hub-shared";
import {
  agentConfigSchema,
  DEFAULT_CONFIG_DIR,
  DEFAULT_DATA_DIR,
  loadAgents,
  setConfigValue,
} from "@agent-team-foundation/first-tree-hub-shared/config";
import { cleanWorkspaces, FirstTreeHubSDK, SdkError, SessionRegistry } from "@first-tree-hub/client";
import type { Command } from "commander";
import { fail, success } from "../cli/output.js";
import { ensureFreshAccessToken, resolveServerUrl, saveAgentConfig } from "../core/bootstrap.js";
import { bindFeishuBot, bindFeishuUser } from "../core/feishu.js";
import { promptAddAgent } from "../core/index.js";
import { registerAgentConfigCommands } from "./agent-config.js";

const DEFAULT_WORKSPACE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

type ResolvedAgentConfig = {
  serverUrl: string;
  agentId: string;
};

/**
 * Resolve the agent this CLI invocation should act on. We read the local
 * `agents/<name>/agent.yaml` file to find the agentId, then pair it with the
 * user's current member JWT (refreshed on demand) at call time.
 *
 * Only one agent is expected per command invocation — if the user has many
 * agents configured they must pick one with `--agent <name>` (next step of
 * CLI polish) or rely on a single entry.
 */
function resolveLocalAgent(agentName?: string): ResolvedAgentConfig {
  const agentsDir = join(DEFAULT_CONFIG_DIR, "agents");
  const agents = loadAgents({ schema: agentConfigSchema, agentsDir });
  if (agents.size === 0) {
    fail("MISSING_AGENT", "No agent configured. Run `first-tree-hub agent add` first.", 2);
  }

  let resolvedName: string;
  if (agentName) {
    resolvedName = agentName;
  } else if (agents.size === 1) {
    const [only] = [...agents.keys()];
    if (!only) fail("MISSING_AGENT", "No agent configured. Run `first-tree-hub agent add` first.", 2);
    resolvedName = only;
  } else {
    fail(
      "AMBIGUOUS_AGENT",
      `Multiple agents configured — specify --agent <name>. Available: ${[...agents.keys()].join(", ")}`,
      2,
    );
  }
  const cfg = agents.get(resolvedName);
  if (!cfg) {
    fail("UNKNOWN_AGENT", `Agent "${resolvedName}" not found in ${agentsDir}`, 2);
  }

  let serverUrl: string;
  try {
    serverUrl = resolveServerUrl(process.env.FIRST_TREE_HUB_SERVER_URL);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    fail("MISSING_SERVER_URL", msg, 2);
  }

  return { serverUrl, agentId: cfg.agentId };
}

function createSdk(agentName?: string): FirstTreeHubSDK {
  const { serverUrl, agentId } = resolveLocalAgent(agentName);
  return new FirstTreeHubSDK({
    serverUrl,
    getAccessToken: () => ensureFreshAccessToken(),
    agentId,
  });
}

function handleSdkError(error: unknown): never {
  if (error instanceof SdkError) {
    const exitCode = error.statusCode === 401 ? 3 : 1;
    fail(`HTTP_${error.statusCode}`, error.message, exitCode);
  }
  if (error instanceof TypeError && "cause" in error) {
    fail("CONNECTION_ERROR", `Cannot connect to server: ${error.message}`, 6);
  }
  const msg = error instanceof Error ? error.message : String(error);
  fail("UNKNOWN_ERROR", msg, 1);
}

function parseLimit(value: string, max: number): number {
  const limit = Number.parseInt(value, 10);
  if (Number.isNaN(limit) || limit < 1 || limit > max) {
    fail("INVALID_LIMIT", `Limit must be between 1 and ${max}.`, 2);
  }
  return limit;
}

const MAX_STDIN_BYTES = 10 * 1024 * 1024;

function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    process.stdin.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_STDIN_BYTES) {
        process.stdin.destroy();
        reject(new Error(`stdin exceeds ${MAX_STDIN_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", reject);
  });
}

type ResolvedAgent = { uuid: string; name: string | null; displayName: string | null };

async function resolveAgent(serverUrl: string, adminToken: string, agentName: string): Promise<ResolvedAgent> {
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

// ── Main registration ─────────────────────────────────────────────────

export function registerAgentCommands(program: Command): void {
  const agent = program.command("agent").description("Agent management — config, bindings, messaging");

  registerAgentConfigCommands(agent);

  // ── Config management (add / remove / list) ─────────────────────────

  agent
    .command("add [name]")
    .description("Register a local alias for an existing Hub agent (stores agentId)")
    .option("--agent-id <id>", "Agent UUID on the Hub")
    .action(async (name?: string, options?: { agentId?: string }) => {
      try {
        let agentName = name;
        let agentId = options?.agentId;

        if (!agentName || !agentId) {
          const result = await promptAddAgent();
          agentName = agentName ?? result.name;
          agentId = agentId ?? result.agentId;
        }
        if (!agentName || !agentId) {
          fail("MISSING_AGENT_ARGS", "Both agent name and agent-id are required.", 2);
        }

        const agentDir = join(DEFAULT_CONFIG_DIR, "agents", agentName);
        mkdirSync(agentDir, { recursive: true, mode: 0o700 });
        setConfigValue(join(agentDir, "agent.yaml"), "agentId", agentId);

        process.stderr.write(`  Agent "${agentName}" added.\n`);
        process.stderr.write(`  Config: ${join(agentDir, "agent.yaml")}\n`);
      } catch (error) {
        if ((error as { name?: string }).name === "ExitPromptError") {
          process.stderr.write("\n  Cancelled.\n");
          return;
        }
        const msg = error instanceof Error ? error.message : String(error);
        process.stderr.write(`  Error: ${msg}\n`);
        process.exit(1);
      }
    });

  agent
    .command("remove <name>")
    .description("Remove a local agent alias and its runtime data")
    .action((name: string) => {
      const agentDir = join(DEFAULT_CONFIG_DIR, "agents", name);
      if (!existsSync(agentDir)) {
        process.stderr.write(`  Agent "${name}" not found.\n`);
        process.exit(1);
      }
      rmSync(agentDir, { recursive: true, force: true });
      rmSync(join(DEFAULT_DATA_DIR, "workspaces", name), { recursive: true, force: true });
      rmSync(join(DEFAULT_DATA_DIR, "sessions", `${name}.json`), { force: true });

      process.stderr.write(`  Agent "${name}" removed.\n`);
    });

  agent
    .command("list")
    .description("List locally-configured agents")
    .action(() => {
      const agentsDir = join(DEFAULT_CONFIG_DIR, "agents");
      try {
        const agents = loadAgents({ schema: agentConfigSchema, agentsDir });
        if (agents.size === 0) {
          process.stderr.write("  No agents configured.\n");
          return;
        }
        for (const [name, config] of agents) {
          process.stderr.write(
            `  ${name.padEnd(20)} runtime: ${config.runtime.padEnd(14)} agentId: ${config.agentId}\n`,
          );
        }
      } catch {
        process.stderr.write("  No agents configured.\n");
      }
    });

  // ── CLI-first agent creation ────────────────────────────────────────

  agent
    .command("create <name>")
    .description("Create an agent on Hub and bind it locally")
    .requiredOption("--type <type>", "Agent type (human, personal_assistant, autonomous_agent)")
    .requiredOption(
      "--client-id <id>",
      "Client (machine) that will run this agent — must be owned by you. Run `first-tree-hub client connect` on that machine first.",
    )
    .option("--runtime <runtime>", "Runtime handler (default: claude-code)", "claude-code")
    .option("--display-name <name>", "Display name")
    .option("--server <url>", "Hub server URL")
    .action(
      async (
        name: string,
        options: { type: string; clientId: string; runtime: string; displayName?: string; server?: string },
      ) => {
        try {
          const serverUrl = resolveServerUrl(options.server);
          const adminToken = await ensureFreshAccessToken();
          const headers = {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          };

          const createBody: Record<string, unknown> = {
            name,
            type: options.type,
            clientId: options.clientId,
          };
          if (options.displayName) createBody.displayName = options.displayName;

          const createRes = await fetch(`${serverUrl}/api/v1/admin/agents`, {
            method: "POST",
            headers,
            body: JSON.stringify(createBody),
            signal: AbortSignal.timeout(10_000),
          });
          if (!createRes.ok) {
            const body = (await createRes.json().catch(() => ({}))) as { error?: string };
            fail("CREATE_ERROR", body.error ?? `Failed to create agent (HTTP ${createRes.status})`, 1);
          }
          const created = (await createRes.json()) as { uuid: string; name: string | null };
          process.stderr.write(`  \u2713 Agent created: ${created.name ?? created.uuid}\n`);

          const agentDir = saveAgentConfig(name, created.uuid, options.runtime);
          process.stderr.write(`  \u2713 Config saved: ${agentDir}/agent.yaml\n`);
          process.stderr.write("  \u2713 Agent ready — start the client on that machine to bind\n");
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          fail("CREATE_ERROR", msg);
        }
      },
    );

  // ── Claim (set manager) ─────────────────────────────────────────────

  agent
    .command("claim <agentName>")
    .description("Become the manager of an agent (admin-only, or self-claim an unmanaged agent)")
    .option("--server <url>", "Hub server URL")
    .action(async (agentName: string, options: { server?: string }) => {
      try {
        const serverUrl = resolveServerUrl(options.server);
        const accessToken = await ensureFreshAccessToken();

        // Look up the authenticated member's id via /me
        const meRes = await fetch(`${serverUrl}/api/v1/me`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!meRes.ok) fail("ME_ERROR", `Failed to fetch current member (HTTP ${meRes.status})`, 1);
        const me = (await meRes.json()) as { memberId: string };

        const target = await resolveAgent(serverUrl, accessToken, agentName);

        const patchRes = await fetch(`${serverUrl}/api/v1/admin/agents/${target.uuid}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ managerId: me.memberId }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!patchRes.ok) {
          const body = (await patchRes.json().catch(() => ({}))) as { error?: string };
          fail("CLAIM_ERROR", body.error ?? `Claim failed (HTTP ${patchRes.status})`, 1);
        }
        process.stderr.write(`  Claimed "${target.name ?? target.uuid}" — now managed by you.\n`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("CLAIM_ERROR", msg);
      }
    });

  // ── Workspace management ────────────────────────────────────────────

  const workspace = agent.command("workspace").description("Manage agent workspaces");

  workspace
    .command("clean [agent-name]")
    .description("Remove stale workspace directories (older than TTL with no active session)")
    .option("--ttl <days>", "TTL in days", String(DEFAULT_WORKSPACE_TTL_MS / (24 * 60 * 60 * 1000)))
    .action((agentName?: string, options?: { ttl: string }) => {
      const defaultDays = DEFAULT_WORKSPACE_TTL_MS / (24 * 60 * 60 * 1000);
      const ttlMs = Number.parseInt(options?.ttl ?? String(defaultDays), 10) * 24 * 60 * 60 * 1000;
      const workspacesDir = join(DEFAULT_DATA_DIR, "workspaces");

      if (!existsSync(workspacesDir)) {
        process.stderr.write("  No workspaces found.\n");
        return;
      }

      const agentNames = agentName ? [agentName] : readdirSync(workspacesDir);
      let totalRemoved = 0;

      for (const name of agentNames) {
        const agentWorkspaceRoot = join(workspacesDir, name);
        if (!existsSync(agentWorkspaceRoot)) continue;

        const registryPath = join(DEFAULT_DATA_DIR, "sessions", `${name}.json`);
        const registry = new SessionRegistry(registryPath);
        const persisted = registry.load();
        const activeChatIds = new Set<string>();
        for (const [chatId, data] of persisted) {
          if (data.status !== "evicted") {
            activeChatIds.add(chatId);
          }
        }

        const removed = cleanWorkspaces(agentWorkspaceRoot, activeChatIds, ttlMs);
        totalRemoved += removed.length;
        for (const chatId of removed) {
          process.stderr.write(`  Removed: ${name}/${chatId}\n`);
        }
      }

      process.stderr.write(`  ${totalRemoved} workspace(s) cleaned.\n`);
    });

  // ── Bind (Feishu bot / user) ────────────────────────────────────────

  const bind = agent.command("bind").description("Bind external IM accounts to agents");

  bind
    .command("bot")
    .description("Bind a Feishu bot to this agent (self-service)")
    .requiredOption("--platform <platform>", "Platform: feishu")
    .requiredOption("--app-id <id>", "Feishu bot App ID")
    .requiredOption("--app-secret <secret>", "Feishu bot App Secret")
    .option("--agent <name>", "Local agent alias (default: first configured)")
    .option("--server <url>", "Hub server URL")
    .action(
      async (options: { platform: string; appId: string; appSecret: string; agent?: string; server?: string }) => {
        try {
          if (options.platform !== "feishu") {
            fail("UNSUPPORTED_PLATFORM", `Platform "${options.platform}" is not supported. Use "feishu".`);
          }

          const serverUrl = resolveServerUrl(options.server);
          const { agentId } = resolveLocalAgent(options.agent);
          const accessToken = await ensureFreshAccessToken();
          await bindFeishuBot(serverUrl, accessToken, agentId, options.appId, options.appSecret);
          process.stderr.write("Feishu bot bound successfully.\n");
          success({ platform: "feishu", bound: true });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          fail("BIND_BOT_ERROR", msg);
        }
      },
    );

  bind
    .command("user <humanAgentId>")
    .description("Bind a Feishu user to a human agent (via delegate_mention)")
    .requiredOption("--platform <platform>", "Platform: feishu")
    .requiredOption("--feishu-id <id>", "Feishu user ID (ou_xxx)")
    .option("--agent <name>", "Local agent alias (default: first configured)")
    .option("--server <url>", "Hub server URL")
    .action(
      async (
        humanAgentId: string,
        options: { platform: string; feishuId: string; agent?: string; server?: string },
      ) => {
        try {
          if (options.platform !== "feishu") {
            fail("UNSUPPORTED_PLATFORM", `Platform "${options.platform}" is not supported. Use "feishu".`);
          }

          const serverUrl = resolveServerUrl(options.server);
          const { agentId } = resolveLocalAgent(options.agent);
          const accessToken = await ensureFreshAccessToken();
          await bindFeishuUser(serverUrl, accessToken, agentId, humanAgentId, options.feishuId);
          process.stderr.write(`Feishu user ${options.feishuId} bound to ${humanAgentId}.\n`);
          success({ platform: "feishu", humanAgentId, feishuUserId: options.feishuId });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          fail("BIND_USER_ERROR", msg);
        }
      },
    );

  // ── Messaging (send / chats / history) ──────────────────────────────

  interface SendOptions {
    format: MessageFormat;
    chat?: boolean;
    metadata?: string;
    replyTo?: string;
    replyToInbox?: string;
    replyToChat?: string;
    agent?: string;
  }

  agent
    .command("send <target> [message]")
    .description("Send a message to an agent or chat")
    .option("-f, --format <format>", "Message format (text|markdown|card)", "text")
    .option("--chat", "Treat target as chat ID instead of agent ID")
    .option("-m, --metadata <json>", "JSON metadata to attach")
    .option("--reply-to <messageId>", "Message ID to reply to")
    .option("--reply-to-inbox <inboxId>", "Cross-chat reply target inbox")
    .option("--reply-to-chat <chatId>", "Cross-chat reply target chat")
    .option("--agent <name>", "Local agent alias (default: first configured)")
    .action(async (target: string, message: string | undefined, options: SendOptions) => {
      try {
        const content = message ?? (await readStdin());
        if (!content) {
          fail("NO_MESSAGE", "No message provided. Pass as argument or pipe via stdin.", 2);
        }

        let metadata: Record<string, unknown> | undefined;
        if (options.metadata) {
          try {
            metadata = JSON.parse(options.metadata) as Record<string, unknown>;
          } catch {
            fail("INVALID_METADATA", "Metadata must be valid JSON.", 2);
          }
        }

        const sdk = createSdk(options.agent);

        if (options.chat) {
          const result = await sdk.sendMessage(target, {
            format: options.format,
            content,
            metadata,
            inReplyTo: options.replyTo,
            replyToInbox: options.replyToInbox,
            replyToChat: options.replyToChat,
          });
          success(result);
        } else {
          const result = await sdk.sendToAgent(target, {
            format: options.format,
            content,
            metadata,
            replyToInbox: options.replyToInbox,
            replyToChat: options.replyToChat,
          });
          success(result);
        }
      } catch (error) {
        handleSdkError(error);
      }
    });

  agent
    .command("chats")
    .description("List chats this agent participates in")
    .option("-l, --limit <number>", "Maximum chats to return (1-100)", "20")
    .option("--cursor <cursor>", "Pagination cursor from previous response")
    .option("--agent <name>", "Local agent alias (default: first configured)")
    .action(async (options: { limit: string; cursor?: string; agent?: string }) => {
      try {
        const limit = parseLimit(options.limit, 100);
        const sdk = createSdk(options.agent);
        const result = await sdk.listChats({ limit, cursor: options.cursor });
        success(result);
      } catch (error) {
        handleSdkError(error);
      }
    });

  agent
    .command("history <chatId>")
    .description("View message history in a chat")
    .option("-l, --limit <number>", "Maximum messages to return (1-100)", "20")
    .option("--cursor <cursor>", "Pagination cursor from previous response")
    .option("--agent <name>", "Local agent alias (default: first configured)")
    .action(async (chatId: string, options: { limit: string; cursor?: string; agent?: string }) => {
      try {
        const limit = parseLimit(options.limit, 100);
        const sdk = createSdk(options.agent);
        const result = await sdk.listMessages(chatId, { limit, cursor: options.cursor });
        success(result);
      } catch (error) {
        handleSdkError(error);
      }
    });

  // ── Runtime status & management ─────────────────────────────────────

  agent
    .command("status [name]")
    .description("Show agent runtime status from Hub server")
    .option("--server <url>", "Hub server URL")
    .action(async (name?: string, options?: { server?: string }) => {
      try {
        const serverUrl = resolveServerUrl(options?.server);
        const response = await fetch(`${serverUrl}/api/v1/admin/agents/activity`, {
          headers: { Authorization: `Bearer ${await ensureFreshAccessToken()}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          fail("FETCH_ERROR", `Server returned ${response.status}`, 1);
        }
        const data = (await response.json()) as {
          total: number;
          running: number;
          byState: { idle: number; working: number; blocked: number; error: number };
          clients: number;
          agents: Array<{
            agentId: string;
            clientId: string | null;
            runtimeType: string | null;
            runtimeState: string | null;
            activeSessions: number | null;
            totalSessions: number | null;
          }>;
        };

        if (name) {
          const ag = data.agents.find((a) => a.agentId === name);
          if (!ag) {
            process.stderr.write(`\n  Agent "${name}" is not running.\n\n`);
            return;
          }
          process.stderr.write(`\n  Agent: ${ag.agentId}\n`);
          process.stderr.write(`  Runtime: ${ag.runtimeType ?? "—"}\n`);
          process.stderr.write(`  State: ${ag.runtimeState ?? "—"}\n`);
          if (ag.activeSessions !== null) {
            process.stderr.write(`  Sessions: ${ag.activeSessions} active / ${ag.totalSessions ?? 0} total\n`);
          }
          if (ag.clientId) {
            process.stderr.write(`  Client: ${ag.clientId}\n`);
          }
          process.stderr.write("\n");
          return;
        }

        process.stderr.write(`\n  Hub: ${serverUrl}\n\n`);
        process.stderr.write(`  Clients: ${data.clients} connected\n`);
        process.stderr.write(`  Agents: ${data.running} running / ${data.total} total\n`);
        process.stderr.write(
          `  Errors: ${data.byState.error} | Blocked: ${data.byState.blocked} | Working: ${data.byState.working} | Idle: ${data.byState.idle}\n\n`,
        );

        if (data.agents.length > 0) {
          const header = `  ${"AGENT".padEnd(18)} ${"RUNTIME".padEnd(14)} ${"STATE".padEnd(10)} SESSIONS`;
          process.stderr.write(`${header}\n`);
          process.stderr.write(`  ${"─".repeat(header.length - 2)}\n`);
          for (const a of data.agents) {
            const sessions = a.activeSessions !== null ? `${a.activeSessions}/${a.totalSessions ?? 0}` : "—";
            process.stderr.write(
              `  ${(a.agentId ?? "").padEnd(18)} ${(a.runtimeType ?? "—").padEnd(14)} ${(a.runtimeState ?? "—").padEnd(10)} ${sessions}\n`,
            );
          }
          process.stderr.write("\n");
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("STATUS_ERROR", msg);
      }
    });

  agent
    .command("reset <name>")
    .description("Reset agent error state to idle")
    .option("--server <url>", "Hub server URL")
    .action(async (name: string, options: { server?: string }) => {
      try {
        const serverUrl = resolveServerUrl(options.server);
        const response = await fetch(`${serverUrl}/api/v1/admin/agents/activity/${name}/reset-activity`, {
          method: "POST",
          headers: { Authorization: `Bearer ${await ensureFreshAccessToken()}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          fail("RESET_ERROR", `Server returned ${response.status}`, 1);
        }
        process.stderr.write(`  Agent "${name}" reset to idle.\n`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("RESET_ERROR", msg);
      }
    });

  // ── Session management ──────────────────────────────────────────────

  agent
    .command("sessions <agent-name>")
    .description("List sessions for an agent")
    .option("--server <url>", "Hub server URL")
    .option("--state <state>", "Filter by session state (active/suspended/evicted)")
    .action(async (agentName: string, options: { server?: string; state?: string }) => {
      try {
        const serverUrl = resolveServerUrl(options.server);
        const adminToken = await ensureFreshAccessToken();
        const agentId = (await resolveAgent(serverUrl, adminToken, agentName)).uuid;
        const qs = options.state ? `?state=${options.state}` : "";
        const response = await fetch(`${serverUrl}/api/v1/admin/sessions/agents/${agentId}${qs}`, {
          headers: { Authorization: `Bearer ${adminToken}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          fail("FETCH_ERROR", `Server returned ${response.status}`, 1);
        }
        const sessions = (await response.json()) as Array<{
          chatId: string;
          state: string;
          runtimeState: string | null;
          lastActivityAt: string;
        }>;
        if (sessions.length === 0) {
          process.stderr.write(`\n  No sessions for "${agentName}".\n\n`);
          return;
        }
        process.stderr.write(`\n  Sessions for "${agentName}":\n\n`);
        const header = `  ${"CHAT".padEnd(40)} ${"STATE".padEnd(12)} ${"RUNTIME".padEnd(10)} LAST ACTIVITY`;
        process.stderr.write(`${header}\n`);
        process.stderr.write(`  ${"─".repeat(header.length - 2)}\n`);
        for (const s of sessions) {
          const chatShort = s.chatId.length > 38 ? `${s.chatId.slice(0, 35)}...` : s.chatId;
          process.stderr.write(
            `  ${chatShort.padEnd(40)} ${s.state.padEnd(12)} ${(s.runtimeState ?? "—").padEnd(10)} ${s.lastActivityAt}\n`,
          );
        }
        process.stderr.write("\n");
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("SESSIONS_ERROR", msg);
      }
    });

  const sessionCmd = agent.command("session").description("Session lifecycle commands");

  for (const [cmd, desc] of [
    ["suspend", "Suspend a session"],
    ["resume", "Resume a suspended session"],
    ["terminate", "Terminate a session"],
  ] as const) {
    sessionCmd
      .command(`${cmd} <agent-name> <chat-id>`)
      .description(desc)
      .option("--server <url>", "Hub server URL")
      .action(async (agentName: string, chatId: string, options: { server?: string }) => {
        try {
          const serverUrl = resolveServerUrl(options.server);
          const adminToken = await ensureFreshAccessToken();
          const agentId = (await resolveAgent(serverUrl, adminToken, agentName)).uuid;
          const response = await fetch(`${serverUrl}/api/v1/admin/sessions/agents/${agentId}/${chatId}/${cmd}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${adminToken}` },
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) {
            const body = await response.text();
            fail("SESSION_CMD_ERROR", `Server returned ${response.status}: ${body}`, 1);
          }
          process.stderr.write(`  Session ${cmd}: ${chatId} → sent\n`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          fail("SESSION_CMD_ERROR", msg);
        }
      });
  }

  // ── Interactive chat ────────────────────────────────────────────────

  agent
    .command("chat <agent-name>")
    .description("Open an interactive chat with an agent (as the current member's human agent)")
    .option("--server <url>", "Hub server URL")
    .action(async (agentName: string, options: { server?: string }) => {
      try {
        const serverUrl = resolveServerUrl(options.server);
        const adminToken = await ensureFreshAccessToken();
        const headers = {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        };

        const targetAgent = await resolveAgent(serverUrl, adminToken, agentName);

        const dmRes = await fetch(`${serverUrl}/api/v1/admin/agents/${targetAgent.uuid}/chats`, {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(10_000),
        });
        if (!dmRes.ok) {
          const body = await dmRes.text();
          fail("DM_ERROR", `Failed to create DM: ${dmRes.status} — ${body}`, 1);
        }
        const dm = (await dmRes.json()) as { id: string };

        process.stderr.write(`\n  Chat with ${targetAgent.displayName ?? targetAgent.name ?? targetAgent.uuid}\n`);
        process.stderr.write(`  Chat ID: ${dm.id}\n`);
        process.stderr.write(`  Type a message and press Enter. Ctrl+C to exit.\n\n`);

        const readline = await import("node:readline");
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr, prompt: "  > " });

        let lastSeenAt: string | null = null;

        const pollMessages = async (): Promise<void> => {
          try {
            const qs = lastSeenAt ? `?limit=50` : `?limit=10`;
            const msgRes = await fetch(`${serverUrl}/api/v1/admin/chats/${dm.id}/messages${qs}`, {
              headers,
              signal: AbortSignal.timeout(10_000),
            });
            if (!msgRes.ok) return;
            const msgData = (await msgRes.json()) as {
              items: Array<{
                id: string;
                senderId: string;
                content: unknown;
                createdAt: string;
              }>;
            };

            const cutoff = lastSeenAt;
            const newMessages = cutoff
              ? msgData.items.filter((m) => m.createdAt > cutoff && m.senderId === targetAgent.uuid).reverse()
              : [];

            for (const msg of newMessages) {
              const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
              const preview = content.length > 500 ? `${content.slice(0, 500)}...` : content;
              process.stderr.write(`\r  [${targetAgent.displayName ?? targetAgent.name ?? "agent"}] ${preview}\n`);
            }

            if (msgData.items.length > 0 && msgData.items[0]) {
              const newest = msgData.items[0].createdAt;
              if (!lastSeenAt || newest > lastSeenAt) {
                lastSeenAt = newest;
              }
            }
          } catch {
            // ignore polling errors
          }
        };

        await pollMessages();

        const pollTimer = setInterval(() => {
          pollMessages().then(() => rl.prompt());
        }, 2000);

        rl.prompt();

        rl.on("line", async (line: string) => {
          const text = line.trim();
          if (!text) {
            rl.prompt();
            return;
          }

          try {
            const sendRes = await fetch(`${serverUrl}/api/v1/admin/chats/${dm.id}/messages`, {
              method: "POST",
              headers,
              body: JSON.stringify({ format: "text", content: text }),
              signal: AbortSignal.timeout(10_000),
            });
            if (!sendRes.ok) {
              const body = await sendRes.text();
              process.stderr.write(`  [error] Failed to send: ${sendRes.status} — ${body}\n`);
            } else {
              const sent = (await sendRes.json()) as { createdAt: string };
              lastSeenAt = sent.createdAt;
            }
          } catch (err) {
            process.stderr.write(`  [error] ${err instanceof Error ? err.message : String(err)}\n`);
          }
          rl.prompt();
        });

        rl.on("close", () => {
          clearInterval(pollTimer);
          process.stderr.write("\n  Chat ended.\n");
          process.exit(0);
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("CHAT_ERROR", msg);
      }
    });

  // ── Low-level SDK debugging (register / pull) ───────────────────────

  agent
    .command("register")
    .description("Register this agent and return identity info")
    .option("--agent <name>", "Local agent alias (default: first configured)")
    .action(async (options: { agent?: string }) => {
      try {
        const sdk = createSdk(options.agent);
        const result = await sdk.register();
        success(result);
      } catch (error) {
        handleSdkError(error);
      }
    });

  agent
    .command("pull")
    .description("Pull pending messages from inbox")
    .option("-l, --limit <number>", "Maximum entries to return", "10")
    .option("-a, --ack", "Automatically ACK entries after pulling")
    .option("--agent <name>", "Local agent alias (default: first configured)")
    .action(async (options: { limit: string; ack?: boolean; agent?: string }) => {
      try {
        const sdk = createSdk(options.agent);
        const limit = parseLimit(options.limit, 50);
        const result = await sdk.pull(limit);

        if (options.ack && result.entries.length > 0) {
          await Promise.all(result.entries.map((entry) => sdk.ack(entry.id)));
        }

        success(result);
      } catch (error) {
        handleSdkError(error);
      }
    });
}
