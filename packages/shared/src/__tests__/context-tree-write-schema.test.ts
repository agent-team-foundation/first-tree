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
        provider: "github",
        binding: { provider: "github", repo: "git@github.com:acme/context-tree.git", branch: "main" },
        gitlabInstanceOrigin: null,
        reviewerAgentUuid: "reviewer-a",
        requesterGithubLogin: "Writer",
      }),
    ).toEqual({
      organizationId: "team-a",
      provider: "github",
      binding: { provider: "github", repo: "git@github.com:acme/context-tree.git", branch: "main" },
      gitlabInstanceOrigin: null,
      reviewerAgentUuid: "reviewer-a",
      requesterGithubLogin: "Writer",
    });
  });

  it("accepts GitLab preflight without a Cloud-linked forge identity", () => {
    expect(contextTreeWritePreflightRequestSchema.parse({})).toEqual({});
    expect(
      contextTreeWritePreflightResponseSchema.parse({
        organizationId: "team-a",
        provider: "gitlab",
        binding: {
          provider: "gitlab",
          repo: "git@gitlab.internal:group/context-tree.git",
          branch: "main",
        },
        gitlabInstanceOrigin: "https://gitlab.internal",
        reviewerAgentUuid: "reviewer-a",
        requesterGithubLogin: null,
      }),
    ).toMatchObject({ provider: "gitlab", requesterGithubLogin: null });
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
        provider: "github",
        binding: { repo: "not-a-git-url", branch: "main" },
        gitlabInstanceOrigin: null,
        reviewerAgentUuid: "reviewer-a",
        requesterGithubLogin: "writer",
      }).success,
    ).toBe(false);
  });

  it("keeps preflight error codes on the shared wire contract", () => {
    expect(contextTreeWritePreflightErrorCodeSchema.parse("CONTEXT_TREE_WRITE_REVIEWER_UNAVAILABLE")).toBe(
      "CONTEXT_TREE_WRITE_REVIEWER_UNAVAILABLE",
    );
    expect(contextTreeWritePreflightErrorCodeSchema.safeParse("CONTEXT_TREE_WRITE_TASK_KEY").success).toBe(false);
  });
});
