import type { ChatGithubEntity, GithubEntityType } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { sortEntitiesByType } from "../github-section.js";

function entity(entityType: GithubEntityType, key: string): ChatGithubEntity {
  return {
    entityType,
    entityKey: key,
    boundVia: "direct",
    htmlUrl: `https://github.com/o/r/${key}`,
    title: null,
    state: null,
    number: null,
  };
}

describe("sortEntitiesByType", () => {
  it("clusters by type in PR → issue → discussion → commit order", () => {
    const items = [
      entity("issue", "i1"),
      entity("commit", "c1"),
      entity("pull_request", "p1"),
      entity("discussion", "d1"),
    ];
    expect(sortEntitiesByType(items).map((e) => e.entityType)).toEqual([
      "pull_request",
      "issue",
      "discussion",
      "commit",
    ]);
  });

  it("preserves server order within a type group (stable)", () => {
    const items = [
      entity("pull_request", "p1"),
      entity("issue", "i1"),
      entity("pull_request", "p2"),
      entity("issue", "i2"),
      entity("pull_request", "p3"),
    ];
    expect(sortEntitiesByType(items).map((e) => e.entityKey)).toEqual(["p1", "p2", "p3", "i1", "i2"]);
  });

  it("does not mutate the input array", () => {
    const items = [entity("issue", "i1"), entity("pull_request", "p1")];
    const before = items.map((e) => e.entityKey);
    sortEntitiesByType(items);
    expect(items.map((e) => e.entityKey)).toEqual(before);
  });
});
