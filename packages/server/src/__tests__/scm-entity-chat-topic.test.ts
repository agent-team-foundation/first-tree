import { describe, expect, it } from "vitest";
import {
  formatContextReviewTopic,
  formatGitlabEntityTopic,
  formatScmAutoTopic,
  refreshGitlabEntityTopic,
  refreshScmAutoTopic,
} from "../services/scm-entity-chat-topic.js";

describe("SCM automatic topics", () => {
  it("renders the provider-neutral head without changing GitHub semantics", () => {
    expect(formatScmAutoTopic("PR repo#7", "Ship it")).toBe("PR repo#7: Ship it");
    expect(formatScmAutoTopic("Issue repo#8", null)).toBe("Issue repo#8");
    expect(refreshScmAutoTopic("manual", "New", [{ matches: "PR repo#7", nextHead: "PR repo#7" }])).toBeNull();
  });

  it("renders stable Context Review topics with provider-native references", () => {
    expect(
      formatContextReviewTopic({
        provider: "github",
        repositoryPath: "agent-team-foundation/first-tree-context",
        changeNumber: 789,
      }),
    ).toBe("Context Review · first-tree-context#789");
    expect(
      formatContextReviewTopic({
        provider: "gitlab",
        repositoryPath: "platform/context/first-tree-context",
        changeNumber: 42,
      }),
    ).toBe("Context Review · first-tree-context!42");
  });

  it("renders all GitLab automatic topic variants", () => {
    const mr = { entityType: "pull_request" as const, entityIid: 17, projectPath: "group/project", title: "Ship" };
    expect(formatGitlabEntityTopic(mr)).toBe("MR project!17: Ship");
    expect(formatGitlabEntityTopic(mr, true)).toBe("MR Review project!17: Ship");
    expect(
      formatGitlabEntityTopic({
        entityType: "issue",
        entityIid: 18,
        projectPath: "group/project",
        title: "Bug",
      }),
    ).toBe("Issue project#18: Bug");
  });

  it("renders stable Context Reviewer topics for both providers", () => {
    expect(
      formatContextReviewTopic({ provider: "github", repositoryPath: "owner/context-tree", changeNumber: 7 }),
    ).toBe("Context Review · context-tree#7");
    expect(
      formatContextReviewTopic({ provider: "gitlab", repositoryPath: "group/platform/context-tree", changeNumber: 8 }),
    ).toBe("Context Review · context-tree!8");
  });

  it("refreshes title and project path while preserving the review head", () => {
    const entity = {
      entityType: "pull_request" as const,
      entityIid: 17,
      projectPath: "renamed/new-project",
      title: "New title",
    };
    expect(refreshGitlabEntityTopic("MR old-project!17: Old title", entity)).toBe("MR new-project!17: New title");
    expect(refreshGitlabEntityTopic("MR Review old-project!17: Old title", entity)).toBe(
      "MR Review new-project!17: New title",
    );
    expect(refreshGitlabEntityTopic("My manually renamed chat", entity)).toBeNull();
    expect(refreshGitlabEntityTopic("MR old-project!18: Other entity", entity)).toBeNull();
  });
});
