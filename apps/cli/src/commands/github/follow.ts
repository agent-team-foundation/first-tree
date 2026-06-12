import type { Command } from "commander";
import { fail, success } from "../../cli/output.js";
import { channelConfig } from "../../core/channel.js";
import { createSdk } from "../_shared/local-agent.js";
import { handleGithubSdkError, resolveTargetChatId } from "./_shared.js";

interface FollowOptions {
  chat?: string;
  rebind?: boolean;
  agent?: string;
}

export function registerGithubFollowCommand(github: Command): void {
  github
    .command("follow <entity>")
    .description(
      "Follow a GitHub entity (PR / Issue / Discussion / Commit): route its webhook events into the current " +
        "chat. <entity> is a GitHub URL, owner/repo#42, or owner/repo@<sha>. Creating a PR or issue never " +
        "follows it for you — declare the dependency yourself, immediately after creation.",
    )
    .option("--chat <chatId>", "Target chat (default: the session's FIRST_TREE_CHAT_ID)")
    .option(
      "--rebind",
      "MOVE the line here when the entity is already followed in another chat (409). Right when the work " +
        "genuinely lives in this chat; wrong when the other chat still owns it — in doubt, ask the human",
    )
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .action(async (entity: string, options: FollowOptions) => {
      try {
        const chatId = resolveTargetChatId(options.chat);
        const sdk = createSdk(options.agent);
        const outcome = await sdk.followGithubEntity(chatId, { entity, rebind: options.rebind === true });

        if (!outcome.ok) {
          const { conflict } = outcome.conflict;
          fail(
            "ENTITY_FOLLOWED_ELSEWHERE",
            `${entity} is already followed in chat ${conflict.chatId}${conflict.topic ? ` ("${conflict.topic}")` : ""}. ` +
              "DEFAULT: work in that chat — the context lives there. If the work has genuinely moved here, " +
              `re-run with --rebind to MOVE the line (it is never duplicated). One common case: you just ` +
              "created this entity and its `opened` webhook minted that chat first — rebind is the right call. " +
              "In doubt, ask the human.",
            1,
          );
        }

        const { status, entity: wired } = outcome.result;
        const hint =
          status === "created"
            ? "Now following — every event on it will wake the wiring agent in this chat. " +
              `Unfollow when the task's attention span closes: \`${channelConfig.binName} github unfollow ${wired.entityKey}\`.`
            : status === "rebound"
              ? "Line moved — events now route into this chat (the previous chat goes quiet)."
              : "Already following in this chat — idempotent success, do not retry.";
        success({ status, entity: wired, hint });
      } catch (error) {
        handleGithubSdkError(error);
      }
    });
}
