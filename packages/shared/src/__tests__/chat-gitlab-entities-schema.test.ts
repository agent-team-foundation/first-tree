import { describe, expect, it } from "vitest";
import {
  chatGitlabEntityListResponseSchema,
  chatGitlabEntitySchema,
  followChatGitlabEntityResponseSchema,
} from "../schemas/chat-gitlab-entities.js";

const pendingEntity = {
  entityType: "pull_request" as const,
  entityUrl: "https://gitlab.example/acme/api/-/merge_requests/42",
  projectPath: "acme/api",
  entityIid: 42,
  title: null,
  state: null,
  status: "pending" as const,
  boundVia: "agent_declared" as const,
};

describe("chat GitLab entity schemas", () => {
  it("accepts the stable pending/active public projection", () => {
    expect(chatGitlabEntitySchema.parse(pendingEntity)).toEqual(pendingEntity);
    expect(
      chatGitlabEntityListResponseSchema.parse({
        items: [{ ...pendingEntity, title: "Ship it", status: "active", state: "opened" }],
      }),
    ).toMatchObject({ items: [{ status: "active", title: "Ship it" }] });
    expect(followChatGitlabEntityResponseSchema.parse({ status: "created", entity: pendingEntity })).toMatchObject({
      status: "created",
    });
  });

  it("accepts automatic identity bindings but rejects internal fields and unknown provenance", () => {
    expect(
      chatGitlabEntitySchema.strict().safeParse({
        ...pendingEntity,
        connectionId: "connection-1",
      }).success,
    ).toBe(false);
    expect(chatGitlabEntitySchema.safeParse({ ...pendingEntity, boundVia: "identity_target" }).success).toBe(true);
    expect(chatGitlabEntitySchema.safeParse({ ...pendingEntity, boundVia: "webhook_guess" }).success).toBe(false);
  });
});
