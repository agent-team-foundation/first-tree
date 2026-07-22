import { contextReviewerRunMessageMetadataSchema } from "./context-review.js";
import {
  type GithubEventCard,
  type GitlabEventCard,
  githubEventCardSchema,
  gitlabEventCardSchema,
} from "./normalized-event.js";

export const TRUSTED_SYSTEM_SENDER_NAMES = {
  github: "GitHub",
  gitlab: "GitLab",
} as const;

export type TrustedSystemSender = keyof typeof TRUSTED_SYSTEM_SENDER_NAMES;

export type TrustedSystemMessageShape = {
  source?: string | null;
  format: string;
  content: unknown;
  metadata: unknown;
};

export function isGithubEventCardContent(content: unknown): content is GithubEventCard {
  return githubEventCardSchema.safeParse(content).success;
}

export function isGitlabEventCardContent(content: unknown): content is GitlabEventCard {
  return gitlabEventCardSchema.safeParse(content).success;
}

export function isGithubSystemSenderMetadata(metadata: unknown): boolean {
  return hasSystemSender(metadata, "github");
}

/**
 * Conjunctive trust gate for GitHub dispatcher attribution. The metadata
 * marker alone is deliberately insufficient because ordinary message sends
 * accept caller-provided metadata.
 */
export function isTrustedGithubDispatcherMessage(message: TrustedSystemMessageShape): boolean {
  if (message.source !== "github") return false;
  if (message.format === "card") {
    return isGithubEventCardContent(message.content) && hasSystemSender(message.metadata, "github");
  }
  return (
    message.format === "markdown" &&
    typeof message.content === "string" &&
    contextReviewerRunMessageMetadataSchema.safeParse(message.metadata).success
  );
}

/** Conjunctive trust gate for GitLab dispatcher attribution. */
export function isTrustedGitlabDispatcherMessage(message: TrustedSystemMessageShape): boolean {
  return (
    message.source === "gitlab" &&
    message.format === "card" &&
    isGitlabEventCardContent(message.content) &&
    hasSystemSender(message.metadata, "gitlab")
  );
}

/** Resolve the synthetic sender shown to trusted message readers. */
export function resolveTrustedSystemSender(message: TrustedSystemMessageShape): TrustedSystemSender | null {
  if (isTrustedGithubDispatcherMessage(message)) return "github";
  if (isTrustedGitlabDispatcherMessage(message)) return "gitlab";
  return null;
}

function hasSystemSender(metadata: unknown, sender: TrustedSystemSender): boolean {
  return typeof metadata === "object" && metadata !== null && Reflect.get(metadata, "systemSender") === sender;
}
