import { describe, expect, it } from "vitest";
import {
  callerWritableChatMetadataSchema,
  FIRST_CHAT_ORIENTATION_CHAT_METADATA_KEY,
  FIRST_CHAT_ORIENTATION_CHAT_STATES,
  optionalChatMetadataSchema,
  readFirstChatOrientationChatState,
  withFirstChatOrientationChatState,
} from "../schemas/chat-metadata.js";
import { kickoffOnboardingSchema } from "../schemas/me-extras.js";
import {
  FIRST_CHAT_ORIENTATION_CONTINUATION_METADATA_KEY,
  FIRST_CHAT_ORIENTATION_METADATA_KEY,
  readFirstChatOrientationContinuationMessageMetadata,
  readFirstChatOrientationMessageMetadata,
} from "../schemas/message.js";

describe("first-chat Orientation message metadata", () => {
  it("accepts only the current versioned marker", () => {
    expect(
      readFirstChatOrientationMessageMetadata({
        [FIRST_CHAT_ORIENTATION_METADATA_KEY]: { version: 1 },
      }),
    ).toEqual({ version: 1 });
    expect(
      readFirstChatOrientationMessageMetadata({
        [FIRST_CHAT_ORIENTATION_METADATA_KEY]: { version: 2 },
      }),
    ).toBeNull();
    expect(readFirstChatOrientationMessageMetadata({})).toBeNull();
  });

  it("accepts only the current server-owned continuation marker", () => {
    expect(
      readFirstChatOrientationContinuationMessageMetadata({
        [FIRST_CHAT_ORIENTATION_CONTINUATION_METADATA_KEY]: { version: 1, targetAgentId: "agent-1" },
      }),
    ).toEqual({ version: 1, targetAgentId: "agent-1" });
    expect(
      readFirstChatOrientationContinuationMessageMetadata({
        [FIRST_CHAT_ORIENTATION_CONTINUATION_METADATA_KEY]: { version: 2, targetAgentId: "agent-1" },
      }),
    ).toBeNull();
    expect(
      readFirstChatOrientationContinuationMessageMetadata({
        [FIRST_CHAT_ORIENTATION_CONTINUATION_METADATA_KEY]: { version: 1 },
      }),
    ).toBeNull();
  });

  it("keeps the server-owned chat lifecycle typed and caller-inaccessible", () => {
    const pending = withFirstChatOrientationChatState({}, FIRST_CHAT_ORIENTATION_CHAT_STATES.PENDING);
    expect(readFirstChatOrientationChatState(pending)).toBe(FIRST_CHAT_ORIENTATION_CHAT_STATES.PENDING);
    expect(optionalChatMetadataSchema.safeParse(pending).success).toBe(true);
    expect(callerWritableChatMetadataSchema.safeParse(pending).success).toBe(false);
    expect(
      readFirstChatOrientationChatState({
        [FIRST_CHAT_ORIENTATION_CHAT_METADATA_KEY]: { version: 1, state: "unknown" },
      }),
    ).toBeNull();
  });

  it("requires an explicit current-version capability on ordinary onboarding kickoffs", () => {
    const ordinary = {
      agentUuid: "agent-1",
      bootstrap: "Welcome aboard.",
      orientation: 1,
    } as const;

    expect(kickoffOnboardingSchema.parse(ordinary).orientation).toBe(1);
    expect(kickoffOnboardingSchema.safeParse({ ...ordinary, orientation: 2 }).success).toBe(false);
    expect(
      kickoffOnboardingSchema.safeParse({
        ...ordinary,
        campaignAction: { campaign: "production-scan", repoSlug: "acme/app" },
      }).success,
    ).toBe(false);
  });
});
