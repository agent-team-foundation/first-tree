import type { Command } from "commander";
import { fail } from "../../cli/output.js";
import { applyChatUpdate } from "./update.js";

type Options = {
  chat?: string;
  clear?: boolean;
  description?: string;
  clearDescription?: boolean;
  agent?: string;
};

function describe(): string {
  return (
    "[DEPRECATED — use `chat update`] Set or clear a chat's topic and/or " +
    "description. The topic is the short display label the workspace chat list " +
    "shows; the description is the chat's work summary + status report, surfaced " +
    "to the agent each turn and used to locate the chat via `chat list`. By " +
    "default acts on the caller's current chat (FIRST_TREE_CHAT_ID); use --chat " +
    "<id> to target another. Owner-gated: the chat's creator may set topic or " +
    "description, and when no agent owner is present (human-created chats, or the " +
    "creator left) every worker agent counts as the owner; a non-owner agent in " +
    "a chat whose agent creator is still present is refused."
  );
}

async function run(topicArg: string | undefined, options: Options): Promise<void> {
  // Deprecation notice on stderr so JSON stdout (success payload) stays clean.
  console.error("warning: `chat set-topic` is deprecated; use `chat update` instead.");

  const chatId = options.chat ?? process.env.FIRST_TREE_CHAT_ID;
  if (!chatId) {
    fail(
      "NO_CHAT_CONTEXT",
      "`chat set-topic` needs a chat to target. Either run it from an agent session that exports FIRST_TREE_CHAT_ID, or pass --chat <id>.",
      2,
    );
  }

  // At least one of the four mutating inputs must be present.
  const wantsTopic = topicArg !== undefined || options.clear === true;
  const wantsDescription = options.description !== undefined || options.clearDescription === true;
  if (!wantsTopic && !wantsDescription) {
    fail("NOTHING_TO_UPDATE", "Provide a topic value, --clear, --description <text>, or --clear-description.", 2);
  }

  const body: { topic?: string | null; description?: string | null } = {};

  // Topic: positional value sets it; --clear unsets it; absent leaves it untouched.
  if (options.clear) {
    if (topicArg !== undefined) {
      fail("CONFLICTING_ARGS", "Pass either --clear or a topic value, not both.", 2);
    }
    body.topic = null;
  } else if (topicArg !== undefined) {
    const trimmed = topicArg.trim();
    if (trimmed.length === 0) {
      fail("EMPTY_TOPIC", "Topic cannot be empty. Use --clear to unset.", 2);
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

export function registerChatSetTopicCommand(chat: Command): void {
  chat
    .command("set-topic [topic]", { hidden: true })
    .alias("rename")
    .description(describe())
    .option("--chat <chatId>", "Target chat id (default: FIRST_TREE_CHAT_ID)")
    .option("--clear", "Clear the topic (sets it to null, falls back to auto-derived title)")
    .option("--description <text>", "Set the chat's running work summary")
    .option("--clear-description", "Clear the description (sets it to null)")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .action(async (topicArg: string | undefined, options: Options) => {
      await run(topicArg, options);
    });
}
