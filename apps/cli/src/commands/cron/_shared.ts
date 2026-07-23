import { SdkError } from "@first-tree/client";
import { fail } from "../../cli/output.js";
import { handleSdkError } from "../_shared/local-agent.js";

export function requireCronChatId(): string {
  const chatId = process.env.FIRST_TREE_CHAT_ID?.trim();
  if (!chatId) {
    fail("NO_CHAT_CONTEXT", "Scheduled job commands require FIRST_TREE_CHAT_ID from the active agent session.", 2);
  }
  return chatId;
}

export function handleCronSdkError(error: unknown): never {
  if (error instanceof SdkError) {
    if (error.statusCode === 409 && error.code === "CRON_JOB_REVISION_MISMATCH") {
      fail(
        "CRON_JOB_REVISION_MISMATCH",
        `${error.message} Re-run \`cron show\` and retry with the latest revision.`,
        1,
      );
    }
    if (error.statusCode === 409 && error.code === "CRON_JOB_NAME_CONFLICT") {
      fail("CRON_JOB_NAME_CONFLICT", `${error.message} Run \`cron list\` or \`cron show\` before retrying create.`, 1);
    }
    if (error.statusCode === 503 && error.code === "CRON_JOBS_DISABLED") {
      fail("CRON_JOBS_DISABLED", error.message, 1);
    }
    if (error.statusCode === 503 && error.code === "CRON_JOBS_UNAVAILABLE") {
      fail("CRON_JOBS_UNAVAILABLE", error.message, 1);
    }
  }
  handleSdkError(error);
}
