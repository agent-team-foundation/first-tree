import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cleanWorkspaces, FirstTreeHubSDK, SdkError, SessionRegistry } from "@first-tree-hub/client";
import type { MessageFormat } from "@first-tree-hub/shared";
import {
  agentConfigSchema,
  DEFAULT_CONFIG_DIR,
  DEFAULT_DATA_DIR,
  loadAgents,
  setConfigValue,
} from "@first-tree-hub/shared/config";
import type { Command } from "commander";
import { fail, success } from "../cli/output.js";
import { bootstrapToken, resolveAgentToken, resolveServerUrl } from "../core/bootstrap.js";
import { bindFeishuBot, bindFeishuUser } from "../core/feishu.js";
import { promptAddAgent } from "../core/index.js";

const DEFAULT_WORKSPACE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── SDK helpers (for send/chats/history/register/pull) ────────────────

function resolveAgentConfig(): { serverUrl: string; token: string } {
  const token = process.env.FIRST_TREE_HUB_TOKEN;
  if (!token) {
    fail("MISSING_TOKEN", "FIRST_TREE_HUB_TOKEN environment variable is required.", 2);
  }
  let serverUrl: string;
  try {
    serverUrl = resolveServerUrl(process.env.FIRST_TREE_HUB_SERVER);
  } catch {
    serverUrl = "http://localhost:8000";
  }
  return { serverUrl, token };
}

function createSdk(): FirstTreeHubSDK {
  const config = resolveAgentConfig();
  return new FirstTreeHubSDK(config);
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

const MAX_STDIN_BYTES = 10 * 1024 * 1024; // 10 MB

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

// ── Main registration ─────────────────────────────────────────────────

export function registerAgentCommands(program: Command): void {
  const agent = program.command("agent").description("Agent management — config, tokens, bindings, messaging");

  // ── Config management (add / remove / list) ─────────────────────────

  agent
    .command("add [name]")
    .description("Add an agent instance")
    .option("-t, --token <token>", "Agent token")
    .action(async (name?: string, options?: { token?: string }) => {
      try {
        let agentName = name;
        let agentToken = options?.token;

        if (!agentName || !agentToken) {
          const result = await promptAddAgent();
          agentName = agentName ?? result.name;
          agentToken = agentToken ?? result.token;
        }

        const agentDir = join(DEFAULT_CONFIG_DIR, "agents", agentName);
        mkdirSync(agentDir, { recursive: true, mode: 0o700 });
        setConfigValue(join(agentDir, "agent.yaml"), "token", agentToken);

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
    .description("Remove an agent instance and its runtime data")
    .action((name: string) => {
      const agentDir = join(DEFAULT_CONFIG_DIR, "agents", name);
      if (!existsSync(agentDir)) {
        process.stderr.write(`  Agent "${name}" not found.\n`);
        process.exit(1);
      }
      rmSync(agentDir, { recursive: true, force: true });

      // Clean runtime data
      rmSync(join(DEFAULT_DATA_DIR, "workspaces", name), { recursive: true, force: true });
      rmSync(join(DEFAULT_DATA_DIR, "sessions", `${name}.json`), { force: true });

      process.stderr.write(`  Agent "${name}" removed.\n`);
    });

  agent
    .command("list")
    .description("List configured agents")
    .action(() => {
      const agentsDir = join(DEFAULT_CONFIG_DIR, "agents");
      try {
        const agents = loadAgents({ schema: agentConfigSchema, agentsDir });
        if (agents.size === 0) {
          process.stderr.write("  No agents configured.\n");
          return;
        }
        for (const [name, config] of agents) {
          const masked = config.token.length > 8 ? `${config.token.slice(0, 6)}***${config.token.slice(-2)}` : "***";
          process.stderr.write(`  ${name.padEnd(20)} type: ${config.type.padEnd(14)} token: ${masked}\n`);
        }
      } catch {
        process.stderr.write("  No agents configured.\n");
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

  // ── Token management ────────────────────────────────────────────────

  const token = agent.command("token").description("Agent token management");

  token
    .command("bootstrap <agentId>")
    .description("Bootstrap a token using GitHub identity (requires gh CLI)")
    .option("--save-to <target>", 'Save token to: "agent" (default) or a file path', "agent")
    .option("--server <url>", "Hub server URL")
    .action(async (agentId: string, options: { saveTo: string; server?: string }) => {
      try {
        const serverUrl = resolveServerUrl(options.server);
        const result = await bootstrapToken(serverUrl, agentId, { saveTo: options.saveTo });

        if (options.saveTo === "agent") {
          process.stderr.write(`Token saved to ~/.first-tree-hub/config/agents/${agentId}/agent.yaml\n`);
        } else {
          process.stderr.write(`Token saved to ${options.saveTo}\n`);
        }

        success({ agentId: result.agentId, tokenSaved: true });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("BOOTSTRAP_ERROR", msg);
      }
    });

  // ── Bind (Feishu bot / user) ────────────────────────────────────────

  const bind = agent.command("bind").description("Bind external IM accounts to agents");

  bind
    .command("bot")
    .description("Bind a Feishu bot to this agent (self-service)")
    .requiredOption("--platform <platform>", "Platform: feishu")
    .requiredOption("--app-id <id>", "Feishu bot App ID")
    .requiredOption("--app-secret <secret>", "Feishu bot App Secret")
    .option("--server <url>", "Hub server URL")
    .action(async (options: { platform: string; appId: string; appSecret: string; server?: string }) => {
      try {
        if (options.platform !== "feishu") {
          fail("UNSUPPORTED_PLATFORM", `Platform "${options.platform}" is not supported. Use "feishu".`);
        }

        const serverUrl = resolveServerUrl(options.server);
        const agentToken = resolveAgentToken();
        await bindFeishuBot(serverUrl, agentToken, options.appId, options.appSecret);
        process.stderr.write("Feishu bot bound successfully.\n");
        success({ platform: "feishu", bound: true });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("BIND_BOT_ERROR", msg);
      }
    });

  bind
    .command("user <humanAgentId>")
    .description("Bind a Feishu user to a human agent (via delegate_mention)")
    .requiredOption("--platform <platform>", "Platform: feishu")
    .requiredOption("--feishu-id <id>", "Feishu user ID (ou_xxx)")
    .option("--server <url>", "Hub server URL")
    .action(async (humanAgentId: string, options: { platform: string; feishuId: string; server?: string }) => {
      try {
        if (options.platform !== "feishu") {
          fail("UNSUPPORTED_PLATFORM", `Platform "${options.platform}" is not supported. Use "feishu".`);
        }

        const serverUrl = resolveServerUrl(options.server);
        const agentToken = resolveAgentToken();
        await bindFeishuUser(serverUrl, agentToken, humanAgentId, options.feishuId);
        process.stderr.write(`Feishu user ${options.feishuId} bound to ${humanAgentId}.\n`);
        success({ platform: "feishu", humanAgentId, feishuUserId: options.feishuId });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("BIND_USER_ERROR", msg);
      }
    });

  // ── Messaging (send / chats / history) ──────────────────────────────

  interface SendOptions {
    format: MessageFormat;
    chat?: boolean;
    metadata?: string;
    replyTo?: string;
    replyToInbox?: string;
    replyToChat?: string;
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

        const sdk = createSdk();

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
    .action(async (options: { limit: string; cursor?: string }) => {
      try {
        const limit = parseLimit(options.limit, 100);
        const sdk = createSdk();
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
    .action(async (chatId: string, options: { limit: string; cursor?: string }) => {
      try {
        const limit = parseLimit(options.limit, 100);
        const sdk = createSdk();
        const result = await sdk.listMessages(chatId, { limit, cursor: options.cursor });
        success(result);
      } catch (error) {
        handleSdkError(error);
      }
    });

  // ── Low-level SDK debugging (register / pull) ───────────────────────

  agent
    .command("register")
    .description("Register this agent and return identity info")
    .action(async () => {
      try {
        const sdk = createSdk();
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
    .action(async (options: { limit: string; ack?: boolean }) => {
      try {
        const sdk = createSdk();
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
