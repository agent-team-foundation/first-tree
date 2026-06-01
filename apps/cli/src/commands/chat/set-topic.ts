import type { Command } from "commander";
import { fail, success } from "../../cli/output.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";

type Options = {
  chat?: string;
  clear?: boolean;
  agent?: string;
};

function describe(): string {
  return (
    "Set or clear the topic (display label) of a chat. The topic is what the " +
    "workspace chat list shows for this chat. By default acts on the caller's " +
    "current chat (FIRST_TREE_CHAT_ID); use --chat <id> to target another."
  );
}

async function run(topicArg: string | undefined, options: Options): Promise<void> {
  const chatId = options.chat ?? process.env.FIRST_TREE_CHAT_ID;
  if (!chatId) {
    fail(
      "NO_CHAT_CONTEXT",
      "`chat set-topic` needs a chat to target. Either run it from an agent session that exports FIRST_TREE_CHAT_ID, or pass --chat <id>.",
      2,
    );
  }

  let topic: string | null;
  if (options.clear) {
    if (topicArg !== undefined) {
      fail("CONFLICTING_ARGS", "Pass either --clear or a topic value, not both.", 2);
    }
    topic = null;
  } else {
    if (topicArg === undefined) {
      fail("MISSING_TOPIC", "Provide a topic value, or use --clear to unset.", 2);
    }
    const trimmed = topicArg.trim();
    if (trimmed.length === 0) {
      fail("EMPTY_TOPIC", "Topic cannot be empty. Use --clear to unset.", 2);
    }
    topic = trimmed;
  }

  try {
    const sdk = createSdk(options.agent);
    const updated = await sdk.updateChat(chatId, { topic });
    success(updated);
  } catch (error) {
    handleSdkError(error);
  }
}

export function registerChatSetTopicCommand(chat: Command): void {
  chat
    .command("set-topic [topic]")
    .alias("rename")
    .description(describe())
    .option("--chat <chatId>", "Target chat id (default: FIRST_TREE_CHAT_ID)")
    .option("--clear", "Clear the topic (sets it to null, falls back to auto-derived title)")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .action(async (topicArg: string | undefined, options: Options) => {
      await run(topicArg, options);
    });
}
