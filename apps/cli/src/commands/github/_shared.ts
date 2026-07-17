import { SdkError } from "@first-tree/client";
import { fail } from "../../cli/output.js";
import { channelConfig } from "../../core/channel.js";
import { handleSdkError } from "../_shared/local-agent.js";

export { resolveTargetChatId } from "../_shared/chat-target.js";

/**
 * Map follow/unfollow SdkErrors to next-step teaching — the error message IS
 * the documentation for an agent that has not read the skill (perception
 * path ④). Falls through to the generic handler for everything else.
 */
export function handleGithubSdkError(error: unknown): never {
  if (error instanceof SdkError) {
    if (error.statusCode === 404) {
      fail(
        "ENTITY_NOT_FOUND",
        `${error.message} The entity does not exist on GitHub — re-check the reference; do not retry.`,
        1,
      );
    }
    if (error.statusCode === 422) {
      fail(
        "NO_APP_INSTALLATION",
        `${error.message} Following can never deliver events without the GitHub App installation — ` +
          "surface this to the human (installing the App is an operator action).",
        1,
      );
    }
    if (error.statusCode === 503) {
      fail(
        "GITHUB_UNAVAILABLE",
        `${error.message} The follow was NOT recorded — retry \`${channelConfig.binName} github follow\` later.`,
        1,
      );
    }
  }
  handleSdkError(error);
}
