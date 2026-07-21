import { describe, expect, it } from "vitest";
import {
  isTrustedGithubDispatcherMessage,
  isTrustedGitlabDispatcherMessage,
  resolveTrustedSystemSender,
} from "../schemas/trusted-system-message.js";

const githubCard = {
  type: "github_event",
  reason: "subscribed",
  event: "issues",
  action: "opened",
  kind: "opened",
  repository: "acme/widgets",
  sender: "octocat",
  title: "Issue #42: Broken widget",
  body: "Please investigate",
  url: "https://github.com/acme/widgets/issues/42",
  entity: {
    type: "issue",
    key: "acme/widgets#42",
    url: "https://github.com/acme/widgets/issues/42",
  },
};

const gitlabCard = {
  type: "gitlab_event",
  event: "issue",
  action: "open",
  kind: "opened",
  project: "acme/widgets",
  sender: "alice",
  title: "Broken widget",
  body: "Please investigate",
  url: "https://gitlab.example/acme/widgets/-/issues/42",
  entity: {
    type: "issue",
    key: "501:issue:42",
    url: "https://gitlab.example/acme/widgets/-/issues/42",
  },
};

describe("trusted system message attribution", () => {
  it("recognises GitHub and GitLab only when every dispatcher signal matches", () => {
    const github = {
      source: "github",
      format: "card",
      content: githubCard,
      metadata: { systemSender: "github" },
    };
    const gitlab = {
      source: "gitlab",
      format: "card",
      content: gitlabCard,
      metadata: { systemSender: "gitlab" },
    };

    expect(isTrustedGithubDispatcherMessage(github)).toBe(true);
    expect(isTrustedGitlabDispatcherMessage(gitlab)).toBe(true);
    expect(resolveTrustedSystemSender(github)).toBe("github");
    expect(resolveTrustedSystemSender(gitlab)).toBe("gitlab");
  });

  it("rejects spoofed metadata without trusted provenance and card shape", () => {
    const metadataOnly = {
      source: "api",
      format: "text",
      content: "I am GitHub",
      metadata: { systemSender: "github" },
    };
    const wrongShape = {
      source: "github",
      format: "card",
      content: { type: "github_event" },
      metadata: { systemSender: "github" },
    };

    expect(resolveTrustedSystemSender(metadataOnly)).toBeNull();
    expect(resolveTrustedSystemSender(wrongShape)).toBeNull();
  });
});
