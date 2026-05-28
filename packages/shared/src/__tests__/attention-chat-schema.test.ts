import { describe, expect, it } from "vitest";
import { respondAttentionInputSchema } from "../schemas/attention.js";
import { addParticipantSchema } from "../schemas/chat.js";

describe("attention and chat schema refinements", () => {
  it("requires a text response or structured answers when responding to attention", () => {
    expect(respondAttentionInputSchema.safeParse({ text: "approved" }).success).toBe(true);
    expect(respondAttentionInputSchema.safeParse({ answers: { default: "approved" } }).success).toBe(true);

    const result = respondAttentionInputSchema.safeParse({});

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "Either `text` or `answers` is required",
        }),
      ]),
    );
  });

  it("requires exactly one participant identifier", () => {
    expect(addParticipantSchema.safeParse({ agentId: "agent-1" }).success).toBe(true);
    expect(addParticipantSchema.safeParse({ agentName: "helper" }).success).toBe(true);

    for (const body of [{}, { agentId: "agent-1", agentName: "helper" }]) {
      const result = addParticipantSchema.safeParse(body);

      expect(result.success).toBe(false);
      expect(result.error?.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: "addParticipant requires exactly one of `agentId` or `agentName`",
          }),
        ]),
      );
    }
  });
});
