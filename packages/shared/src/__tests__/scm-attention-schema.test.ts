import { describe, expect, it } from "vitest";
import { scmAudienceEntrySchema } from "../schemas/scm-attention.js";

describe("SCM attention schema", () => {
  it("requires complete human and wake ownership for a durable line", () => {
    expect(
      scmAudienceEntrySchema.safeParse({
        kind: "existing_line",
        line: {
          kind: "attention_line",
          humanAgentId: "human-1",
          wakeAgentId: null,
          chatId: "chat-1",
          provenance: "explicit",
        },
      }).success,
    ).toBe(false);
  });

  it("represents route-only legacy data as a separate discriminant", () => {
    expect(
      scmAudienceEntrySchema.parse({
        kind: "legacy_route",
        route: {
          kind: "legacy_route_only",
          chatId: "chat-1",
          senderAgentId: "legacy-actor",
          wakeAgentId: null,
          provenance: "legacy_explicit",
        },
      }),
    ).toMatchObject({ kind: "legacy_route" });
  });
});
