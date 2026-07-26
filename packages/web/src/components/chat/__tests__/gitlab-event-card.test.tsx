import type { GitlabEventCard } from "@first-tree/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  GitlabEventCardMessage,
  isGitlabEventCardContent,
  isTrustedGitlabDispatcherMessage,
} from "../gitlab-event-card.js";

const card: GitlabEventCard = {
  type: "gitlab_event",
  event: "issue",
  action: "open",
  kind: "opened",
  project: "Acme/API",
  sender: "alice",
  title: "Webhook issue",
  body: "Please investigate",
  url: "https://gitlab.internal/Acme/API/-/issues/42",
  entity: { type: "issue", key: "501:issue:42", url: "https://gitlab.internal/Acme/API/-/issues/42" },
};

describe("GitLab event card", () => {
  it("requires source, format, schema, and trusted metadata together", () => {
    expect(isGitlabEventCardContent(card)).toBe(true);
    expect(
      isTrustedGitlabDispatcherMessage({
        source: "gitlab",
        format: "card",
        content: card,
        metadata: { systemSender: "gitlab" },
      }),
    ).toBe(true);
    expect(
      isTrustedGitlabDispatcherMessage({
        source: "api",
        format: "card",
        content: card,
        metadata: { systemSender: "gitlab" },
      }),
    ).toBe(false);
  });

  it("renders the basic entity surface", () => {
    const html = renderToStaticMarkup(<GitlabEventCardMessage content={card} />);
    expect(html).toContain("Acme/API");
    expect(html).toContain("Webhook issue");
    expect(html).toContain("Please investigate");
  });
});
