import type { Attention, ListAttentionsQuery } from "@first-tree/shared";
import type { Command } from "commander";
import { fail, success } from "../../cli/output.js";
import { listAttentions } from "../../core/attention/index.js";
import { print } from "../../core/output.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";

interface ListOptions {
  raisedByMe?: boolean;
  state?: string;
  fromAgent?: string;
  inChat?: string;
  limit?: string;
  agent?: string;
  groupByChat?: boolean;
}

export function registerAttentionListCommand(parent: Command): void {
  parent
    .command("list")
    .description("List attentions visible to this agent (default: attentions targeting me)")
    .option("--raised-by-me", "Show attentions this agent raised, instead of those targeting it")
    .option("--state <state>", "open | closed | all (default: open)")
    .option("--from-agent <id>", "Filter to attentions raised by this origin agent id")
    .option("--in-chat <id>", "Filter to attentions anchored to this chat id")
    .option("-l, --limit <number>", "Max records to return (1-200)")
    .option("--agent <name>", "Agent name on the Hub (default: first configured on this client)")
    .option("--group-by-chat", "Render a human-readable grouping by chat on stderr (still emits JSON on stdout)")
    .action(async (options: ListOptions) => {
      try {
        const filter: Partial<ListAttentionsQuery> = {};

        if (options.state !== undefined) {
          if (options.state !== "open" && options.state !== "closed" && options.state !== "all") {
            fail("INVALID_STATE", `--state must be one of: open, closed, all (got "${options.state}").`, 2);
          }
          filter.state = options.state;
        }

        if (options.inChat !== undefined) {
          filter.chat = options.inChat;
        }

        // Default semantics: target=me (the calling agent). When --raised-by-me
        // is set we flip to agent=me; an explicit --from-agent overrides both
        // by pinning a specific origin agent id.
        const sdk = createSdk(options.agent);
        const meId = sdk.agentId;
        if (meId === undefined) {
          fail(
            "AGENT_REQUIRED",
            "Could not determine the calling agent. Pass --agent <name> or run inside an agent session.",
            2,
          );
        }
        if (options.fromAgent !== undefined) {
          filter.agent = options.fromAgent;
        } else if (options.raisedByMe === true) {
          filter.agent = meId;
        } else {
          filter.target = meId;
        }

        if (options.limit !== undefined) {
          const parsed = Number.parseInt(options.limit, 10);
          if (Number.isNaN(parsed) || parsed < 1 || parsed > 200) {
            fail("INVALID_LIMIT", "Limit must be between 1 and 200.", 2);
          }
          filter.limit = parsed;
        }

        const records = await listAttentions(sdk, filter);
        if (options.groupByChat === true) {
          // `print.line` is auto-silenced in --json mode so scripted consumers
          // get a clean stdout envelope; human readers get the grouping on stderr.
          for (const block of renderGroupedByChat(records)) {
            print.line(block);
          }
        }
        success(records);
      } catch (error) {
        handleSdkError(error);
      }
    });
}

/**
 * Format attentions grouped by `originChatId`, newest open requests first.
 * Yields plain text blocks suitable for `print.line` (each already ending
 * in a newline). One block per chat, listing the chat id then one line per
 * Attention. Closed records are dimmed with a `·` marker; open requests
 * with `!`.
 */
export function* renderGroupedByChat(records: Attention[]): Generator<string> {
  const groups = new Map<string, Attention[]>();
  for (const r of records) {
    const arr = groups.get(r.originChatId) ?? [];
    arr.push(r);
    groups.set(r.originChatId, arr);
  }
  // Sort groups so chats with the most "needs reply" rows come first.
  const sortedChats = [...groups.entries()].sort(([, a], [, b]) => {
    const openA = a.filter((x) => x.state === "open" && x.requiresResponse).length;
    const openB = b.filter((x) => x.state === "open" && x.requiresResponse).length;
    return openB - openA;
  });
  for (const [chatId, list] of sortedChats) {
    const openCount = list.filter((x) => x.state === "open" && x.requiresResponse).length;
    const header = openCount > 0 ? `chat ${chatId}  (${openCount} open ask)` : `chat ${chatId}`;
    yield `\n${header}\n`;
    const sorted = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const att of sorted) {
      const marker = att.state === "open" && att.requiresResponse ? "!" : "·";
      const tag = att.requiresResponse ? "ask " : "note";
      const id = att.id.slice(0, 8);
      const subjectClip = att.subject.length > 60 ? `${att.subject.slice(0, 57)}…` : att.subject;
      yield `  ${marker} ${tag}  ${id}  ${subjectClip}\n`;
    }
  }
}
