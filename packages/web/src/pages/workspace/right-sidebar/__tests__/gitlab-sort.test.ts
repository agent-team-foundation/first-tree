import type { ChatGitlabEntity, ChatGitlabEntityType } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { sortGitlabEntitiesByType } from "../gitlab-section.js";

function entity(entityType: ChatGitlabEntityType, entityIid: number): ChatGitlabEntity {
  const segment = entityType === "pull_request" ? "merge_requests" : "issues";
  return {
    entityType,
    entityUrl: `https://gitlab.example/acme/api/-/${segment}/${entityIid}`,
    projectPath: "acme/api",
    entityIid,
    title: null,
    state: "open",
    status: "active",
    boundVia: "identity_target",
  };
}

describe("sortGitlabEntitiesByType", () => {
  it("clusters merge requests before issues without mutating input", () => {
    const items = [entity("issue", 1), entity("pull_request", 2), entity("issue", 3)];
    const before = items.map((item) => item.entityIid);

    expect(sortGitlabEntitiesByType(items).map((item) => item.entityIid)).toEqual([2, 1, 3]);
    expect(items.map((item) => item.entityIid)).toEqual(before);
  });
});
