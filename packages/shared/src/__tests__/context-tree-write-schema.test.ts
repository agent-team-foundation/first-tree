import { describe, expect, it } from "vitest";
import {
  contextTreeWritePreflightErrorCodeSchema,
  contextTreeWritePreflightRequestSchema,
  contextTreeWritePreflightResponseSchema,
} from "../schemas/context-tree-write.js";

describe("Context Tree Write preflight schemas", () => {
  it("accepts the narrow member request and current authority tuple", () => {
    expect(contextTreeWritePreflightRequestSchema.parse({ requesterGithubLogin: " writer " })).toEqual({
      requesterGithubLogin: "writer",
    });
    expect(
      contextTreeWritePreflightResponseSchema.parse({
        organizationId: "team-a",
        binding: { repo: "git@github.com:acme/context-tree.git", branch: "main" },
        requesterGithubLogin: "Writer",
      }),
    ).toEqual({
      organizationId: "team-a",
      binding: { repo: "git@github.com:acme/context-tree.git", branch: "main" },
      requesterGithubLogin: "Writer",
    });
  });

  it("rejects caller-supplied authority and malformed bindings", () => {
    expect(
      contextTreeWritePreflightRequestSchema.safeParse({
        requesterGithubLogin: "writer",
        reviewerAgentUuid: "caller-selected",
      }).success,
    ).toBe(false);
    expect(
      contextTreeWritePreflightResponseSchema.safeParse({
        organizationId: "team-a",
        binding: { repo: "not-a-git-url", branch: "main" },
        requesterGithubLogin: "writer",
      }).success,
    ).toBe(false);
  });

  it("keeps preflight error codes on the shared wire contract", () => {
    expect(contextTreeWritePreflightErrorCodeSchema.parse("CONTEXT_TREE_WRITE_CONFIGURATION_INVALID")).toBe(
      "CONTEXT_TREE_WRITE_CONFIGURATION_INVALID",
    );
    expect(contextTreeWritePreflightErrorCodeSchema.safeParse("CONTEXT_TREE_WRITE_TASK_KEY").success).toBe(false);
  });
});
