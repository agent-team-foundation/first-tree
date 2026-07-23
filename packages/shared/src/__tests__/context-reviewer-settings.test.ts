import { describe, expect, it } from "vitest";
import {
  contextReviewerAssignmentInputSchema,
  contextReviewerCandidatesOutputSchema,
  contextReviewerEnablementInputSchema,
} from "../schemas/context-reviewer-settings.js";

describe("Context Reviewer owner contract", () => {
  it("keeps assignment and enablement as strict independent inputs", () => {
    expect(contextReviewerAssignmentInputSchema.parse({ agentUuid: "agent-1" })).toEqual({
      agentUuid: "agent-1",
    });
    expect(contextReviewerAssignmentInputSchema.parse({ agentUuid: null })).toEqual({
      agentUuid: null,
    });
    expect(contextReviewerEnablementInputSchema.parse({ enabled: false })).toEqual({
      enabled: false,
    });
    expect(
      contextReviewerAssignmentInputSchema.safeParse({
        agentUuid: "agent-1",
        assignedByMemberId: "member-1",
      }).success,
    ).toBe(false);
    expect(
      contextReviewerEnablementInputSchema.safeParse({
        enabled: true,
        consent: true,
      }).success,
    ).toBe(false);
  });

  it("projects only Team-safe candidate facts and typed runtime health", () => {
    expect(
      contextReviewerCandidatesOutputSchema.parse({
        items: [
          {
            uuid: "agent-1",
            name: "reviewer",
            displayName: "Reviewer",
            visibility: "organization",
            runtime: {
              health: "degraded",
              blockers: [
                {
                  code: "context_review_agent_runtime_unavailable",
                  resolutionOwner: "admin",
                  actionKind: "open_agent_owner_flow",
                },
              ],
            },
          },
        ],
        blockers: [],
      }),
    ).toMatchObject({
      items: [
        {
          uuid: "agent-1",
          visibility: "organization",
          runtime: { health: "degraded" },
        },
      ],
    });
  });
});
