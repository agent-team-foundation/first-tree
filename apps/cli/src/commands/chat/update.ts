import type { Command } from "commander";
import { fail, success } from "../../cli/output.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";

type Options = {
  chat?: string;
  topic?: string;
  clearTopic?: boolean;
  description?: string;
  clearDescription?: boolean;
  agent?: string;
};

function describe(): string {
  return (
    "Update a chat's topic and/or description — each updates independently. " +
    "The topic is the short display label the workspace chat list shows. The " +
    "description is the chat's work summary + status report: task background + " +
    "plan + progress, Markdown-supported, surfaced to the agent each turn, shown " +
    "by default at the top of the chat's right sidebar, and used to locate the " +
    "chat via `chat list`. Keep blockers / decisions OUT of the description — " +
    "raise `chat send <human> --request` for those. By default acts on the " +
    "caller's current chat (FIRST_TREE_CHAT_ID); use --chat <id> to target " +
    "another. Owner-gated: the chat's creator may update it, and when no agent " +
    "owner is present (human-created chats, or the creator left) every worker " +
    "agent counts as the owner; a non-owner agent in a chat whose agent creator " +
    "is still present is refused with 403."
  );
}

/**
 * Shared body for `chat update` and the deprecated `chat set-topic` alias.
 * `body` already encodes the intent: a field set to a string sets it, `null`
 * clears it, and an absent field leaves it untouched. The PATCH is owner-gated
 * server-side (`assertOwner`).
 */
export async function applyChatUpdate(
  chatId: string,
  body: { topic?: string | null; description?: string | null },
  agent: string | undefined,
): Promise<void> {
  try {
    const sdk = createSdk(agent);
    const updated = await sdk.updateChat(chatId, body);
    success(updated);
  } catch (error) {
    handleSdkError(error);
  }
}

async function run(options: Options): Promise<void> {
  const chatId = options.chat ?? process.env.FIRST_TREE_CHAT_ID;
  if (!chatId) {
    fail(
      "NO_CHAT_CONTEXT",
      "`chat update` needs a chat to target. Either run it from an agent session that exports FIRST_TREE_CHAT_ID, or pass --chat <id>.",
      2,
    );
  }

  const wantsTopic = options.topic !== undefined || options.clearTopic === true;
  const wantsDescription = options.description !== undefined || options.clearDescription === true;
  if (!wantsTopic && !wantsDescription) {
    fail(
      "NOTHING_TO_UPDATE",
      "Provide at least one of --topic <text>, --clear-topic, --description <text>, or --clear-description.",
      2,
    );
  }

  const body: { topic?: string | null; description?: string | null } = {};

  // Topic: --topic sets it; --clear-topic unsets it; mutually exclusive.
  if (options.topic !== undefined && options.clearTopic === true) {
    fail("CONFLICTING_ARGS", "Pass either --topic or --clear-topic, not both.", 2);
  }
  if (options.clearTopic === true) {
    body.topic = null;
  } else if (options.topic !== undefined) {
    const trimmed = options.topic.trim();
    if (trimmed.length === 0) {
      fail("EMPTY_TOPIC", "Topic cannot be empty. Use --clear-topic to unset.", 2);
    }
    body.topic = trimmed;
  }

  // Description: --description sets it; --clear-description unsets it; mutually exclusive.
  if (options.description !== undefined && options.clearDescription === true) {
    fail("CONFLICTING_ARGS", "Pass either --description or --clear-description, not both.", 2);
  }
  if (options.clearDescription === true) {
    body.description = null;
  } else if (options.description !== undefined) {
    const trimmed = options.description.trim();
    if (trimmed.length === 0) {
      fail("EMPTY_DESCRIPTION", "Description cannot be empty. Use --clear-description to unset.", 2);
    }
    body.description = trimmed;
  }

  await applyChatUpdate(chatId, body, options.agent);
}

export function registerChatUpdateCommand(chat: Command): void {
  chat
    .command("update")
    .description(describe())
    .option("--chat <chatId>", "Target chat id (default: FIRST_TREE_CHAT_ID)")
    .option("--topic <text>", "Set the chat's short display label")
    .option("--clear-topic", "Clear the topic (falls back to auto-derived title)")
    .option("--description <text>", "Set the chat's work summary + status report (Markdown supported)")
    .option("--clear-description", "Clear the description (sets it to null)")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .action(async (options: Options) => {
      await run(options);
    });
}
