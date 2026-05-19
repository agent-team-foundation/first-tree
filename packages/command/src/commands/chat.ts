import { join } from "node:path";
import type { MessageFormat } from "@agent-team-foundation/first-tree-hub-shared";
import { agentConfigSchema, DEFAULT_CONFIG_DIR, loadAgents } from "@agent-team-foundation/first-tree-hub-shared/config";
import { FirstTreeHubSDK, SdkError } from "@first-tree-hub/client";
import type { Command } from "commander";
import { fail, success } from "../cli/output.js";
import { resolveSenderName } from "../core/agent-messaging.js";
import { ensureFreshAccessToken, resolveServerUrl } from "../core/bootstrap.js";
import { cliFetch } from "../core/cli-fetch.js";
import { print } from "../core/output.js";
import { CLI_USER_AGENT } from "../core/version.js";

type ResolvedAgentConfig = {
  serverUrl: string;
  agentId: string;
};

function resolveLocalAgent(agentName?: string): ResolvedAgentConfig {
  const agentsDir = join(DEFAULT_CONFIG_DIR, "agents");
  const agents = loadAgents({ schema: agentConfigSchema, agentsDir });

  const resolution = resolveSenderName({
    override: agentName,
    envAgentId: process.env.FIRST_TREE_HUB_AGENT_ID,
    agents,
  });

  let resolvedName: string;
  if (resolution.kind === "ok") {
    resolvedName = resolution.name;
  } else if (resolution.kind === "none") {
    fail("MISSING_AGENT", "No agent configured. Run `first-tree-hub agent add` first.", 2);
  } else if (resolution.kind === "envMismatch") {
    fail(
      "ENV_AGENT_NOT_LOCAL",
      `FIRST_TREE_HUB_AGENT_ID="${resolution.envAgentId}" is not configured on this machine. ` +
        `Available local agents: ${resolution.available.join(", ")}. ` +
        `Pick one explicitly: \`first-tree-hub chat send --agent <senderName> <recipientName> "..."\`.`,
      2,
    );
  } else {
    fail(
      "AMBIGUOUS_AGENT",
      `Multiple agents are configured on this machine (${resolution.available.join(", ")}) and ` +
        `FIRST_TREE_HUB_AGENT_ID is not set, so the CLI can't tell which one is the sender. ` +
        `Specify it explicitly: \`first-tree-hub chat send --agent <senderName> <recipientName> "..."\` ` +
        `(--agent picks the SENDER; the recipient is the next positional argument).`,
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
    getAccessToken: (opts) => ensureFreshAccessToken(opts),
    agentId,
    userAgent: CLI_USER_AGENT,
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
  const res = await cliFetch(`${serverUrl}/api/v1/me/managed-agents`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    fail("FETCH_ERROR", `Failed to list agents: ${res.status}`, 1);
  }
  const items = (await res.json()) as ResolvedAgent[];
  const found = items.find((a) => a.name === agentName || a.uuid === agentName);
  if (!found) {
    fail("NOT_FOUND", `Agent "${agentName}" not found`, 1);
  }
  return found;
}

interface SendOptions {
  format: MessageFormat;
  metadata?: string;
  agent?: string;
}

export function registerChatCommands(program: Command): void {
  const chat = program.command("chat").description("Chats and messaging — list, history, send, open");

  chat
    .command("send <agentName> [message]")
    .description(
      "Send a message to an agent in the caller's current chat (the chat identified by FIRST_TREE_HUB_CHAT_ID). The recipient must already be a participant; run `chat invite <agentName>` first if they are not.",
    )
    .option("-f, --format <format>", "Message format (text|markdown|card)", "text")
    .option("-m, --metadata <json>", "JSON metadata to attach")
    .option("--agent <name>", "Agent name on the Hub (default: first configured on this client)")
    .action(async (agentName: string, message: string | undefined, options: SendOptions) => {
      try {
        const chatId = process.env.FIRST_TREE_HUB_CHAT_ID;
        if (!chatId) {
          fail(
            "NO_CHAT_CONTEXT",
            "`chat send` must be run from within an agent session that exports FIRST_TREE_HUB_CHAT_ID. " +
              "Hub keeps a single group-chat model — there is no implicit direct chat to fall back to. " +
              "To send from a shell, open the chat in the web UI instead.",
            2,
          );
        }

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

        const result = await sdk.sendMessage(chatId, {
          format: options.format,
          content: `@${agentName} ${content}`,
          metadata,
          // Server resolves the name against the current chat's participant
          // list and adds it to mentions; an unknown name fails the write
          // with a `chat invite` hint.
          receiverNames: [agentName],
        });
        success(result);
      } catch (error) {
        handleSdkError(error);
      }
    });

  chat
    .command("invite <agentName>")
    .description(
      "Invite an agent into the caller's current chat (the chat identified by FIRST_TREE_HUB_CHAT_ID). Use before `chat send <agentName>` when the recipient is not yet a member.",
    )
    .option("--agent <name>", "Agent name on the Hub (default: first configured on this client)")
    .action(async (agentName: string, options: { agent?: string }) => {
      try {
        const chatId = process.env.FIRST_TREE_HUB_CHAT_ID;
        if (!chatId) {
          fail(
            "NO_CHAT_CONTEXT",
            "`chat invite` must be run from within an agent session that exports FIRST_TREE_HUB_CHAT_ID — there is no chat context to invite into otherwise.",
            2,
          );
        }
        const sdk = createSdk(options.agent);
        const participants = await sdk.addChatParticipant(chatId, { agentName });
        success(participants);
      } catch (error) {
        handleSdkError(error);
      }
    });

  chat
    .command("list")
    .description("List chats this agent participates in")
    .option("-l, --limit <number>", "Maximum chats to return (1-100)", "20")
    .option("--cursor <cursor>", "Pagination cursor from previous response")
    .option("--agent <name>", "Agent name on the Hub (default: first configured on this client)")
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

  chat
    .command("history <chatId>")
    .description("View message history in a chat")
    .option("-l, --limit <number>", "Maximum messages to return (1-100)", "20")
    .option("--cursor <cursor>", "Pagination cursor from previous response")
    .option("--agent <name>", "Agent name on the Hub (default: first configured on this client)")
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

  chat
    .command("open <agent-name>")
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

        const dmRes = await cliFetch(`${serverUrl}/api/v1/agents/${targetAgent.uuid}/chats`, {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(10_000),
        });
        if (!dmRes.ok) {
          const body = await dmRes.text();
          fail("DM_ERROR", `Failed to create DM: ${dmRes.status} — ${body}`, 1);
        }
        const dm = (await dmRes.json()) as { id: string };

        print.line(`\n  Chat with ${targetAgent.displayName ?? targetAgent.name ?? targetAgent.uuid}\n`);
        print.line(`  Chat ID: ${dm.id}\n`);
        print.line(`  Type a message and press Enter. Ctrl+C to exit.\n\n`);

        const readline = await import("node:readline");
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr, prompt: "  > " });

        let lastSeenAt: string | null = null;

        const pollMessages = async (): Promise<void> => {
          try {
            const qs = lastSeenAt ? `?limit=50` : `?limit=10`;
            const msgRes = await cliFetch(`${serverUrl}/api/v1/chats/${dm.id}/messages${qs}`, {
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
              print.line(`\r  [${targetAgent.displayName ?? targetAgent.name ?? "agent"}] ${preview}\n`);
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
            const sendRes = await cliFetch(`${serverUrl}/api/v1/chats/${dm.id}/messages`, {
              method: "POST",
              headers,
              body: JSON.stringify({ format: "text", content: text }),
              signal: AbortSignal.timeout(10_000),
            });
            if (!sendRes.ok) {
              const body = await sendRes.text();
              print.line(`  [error] Failed to send: ${sendRes.status} — ${body}\n`);
            } else {
              const sent = (await sendRes.json()) as { createdAt: string };
              lastSeenAt = sent.createdAt;
            }
          } catch (err) {
            print.line(`  [error] ${err instanceof Error ? err.message : String(err)}\n`);
          }
          rl.prompt();
        });

        rl.on("close", () => {
          clearInterval(pollTimer);
          print.line("\n  Chat ended.\n");
          process.exit(0);
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("CHAT_ERROR", msg);
      }
    });
}
