import type { GithubEventCard } from "@first-tree/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  GITHUB_SYSTEM_SENDER_NAME,
  GithubEventCardMessage,
  GithubSystemAvatar,
  isGithubEventCardContent,
  isGithubSystemSenderMetadata,
  isTrustedGithubDispatcherMessage,
} from "../github-event-card.js";

function card(overrides: Partial<GithubEventCard> = {}): GithubEventCard {
  return {
    type: "github_event",
    reason: overrides.reason ?? "mentioned",
    event: overrides.event ?? "pull_request",
    action: overrides.action ?? "opened",
    kind: overrides.kind ?? "opened",
    repository: overrides.repository ?? "acme/web",
    sender: overrides.sender ?? "alice",
    title: overrides.title ?? "Ship the release",
    body: overrides.body ?? "Please review @gandy before merge.",
    url: overrides.url ?? "https://github.com/acme/web/pull/42",
    entity: overrides.entity ?? {
      type: "pull_request",
      key: "acme/web#42",
      url: "https://github.com/acme/web/pull/42",
    },
    mentionedUser: overrides.mentionedUser ?? "gandy",
  };
}

describe("GitHub event card", () => {
  it("validates trusted dispatcher messages and metadata gates", () => {
    const content = card();
    expect(isGithubEventCardContent(content)).toBe(true);
    expect(isGithubEventCardContent({ ...content, type: "github_mention" })).toBe(false);
    expect(isGithubSystemSenderMetadata({ systemSender: "github" })).toBe(true);
    expect(isGithubSystemSenderMetadata({ systemSender: "agent" })).toBe(false);

    expect(
      isTrustedGithubDispatcherMessage({
        source: "github",
        format: "card",
        content,
        metadata: { systemSender: "github" },
      }),
    ).toBe(true);
    expect(
      isTrustedGithubDispatcherMessage({
        source: "web",
        format: "card",
        content,
        metadata: { systemSender: "github" },
      }),
    ).toBe(false);
  });

  it("renders entity labels, action verbs, sender avatar, mention highlights, and fallbacks", () => {
    const html = renderToStaticMarkup(<GithubEventCardMessage content={card()} />);
    expect(html).toContain("PR");
    expect(html).toContain("#42");
    expect(html).toContain("Ship the release");
    expect(html).toContain("@alice");
    expect(html).toContain("mentioned you");
    expect(html).toContain("@gandy");
    expect(renderToStaticMarkup(<GithubSystemAvatar />)).toContain(GITHUB_SYSTEM_SENDER_NAME);

    const noEntityUrl = renderToStaticMarkup(
      <GithubEventCardMessage
        content={card({
          reason: "subscribed",
          kind: "review_requested",
          body: "",
          entity: { type: "issue", key: "other/repo#7", url: null },
          repository: "other/repo",
          url: "",
          title: "",
        })}
      />,
    );
    expect(noEntityUrl).toContain("Issue");
    expect(noEntityUrl).toContain("#7");
    expect(noEntityUrl).toContain("repo");
    expect(noEntityUrl).toContain("requested a review");
  });

  it("covers subscribed verbs and long body truncation", () => {
    const kinds: Array<GithubEventCard["kind"]> = [
      "closed",
      "merged",
      "reopened",
      "commented",
      "reviewed",
      "review_comment",
      "synchronized",
      "commit_commented",
      "assigned",
      "edited",
      "other",
    ];
    for (const kind of kinds) {
      const html = renderToStaticMarkup(
        <GithubEventCardMessage
          content={card({
            reason: "subscribed",
            kind,
            body: kind === "commented" ? "gandy should see this bare mention" : "x".repeat(400),
            mentionedUser: "gandy",
          })}
        />,
      );
      expect(html).toContain("@alice");
    }
  });

  it("contains long GitHub tokens without clipping the mobile timeline", () => {
    const commitSha = "abcdef0123456789".repeat(3).slice(0, 40);
    const longRepository = `organization-${"long".repeat(20)}/repository-${"wide".repeat(20)}`;
    const html = renderToStaticMarkup(
      <GithubEventCardMessage
        content={card({
          event: "commit_comment",
          kind: "commit_commented",
          title: `release-${"unbroken".repeat(20)}`,
          repository: longRepository,
          body: `check-${"unbroken".repeat(40)}`,
          entity: {
            type: "commit",
            key: `${longRepository}@${commitSha}`,
            url: `https://github.com/acme/web/commit/${commitSha}`,
          },
        })}
      />,
    );

    expect(html).toContain("data-github-card-entity");
    expect(html).toContain("data-github-card-entity-number");
    expect(html).toContain("data-github-card-title");
    expect(html).toContain("data-github-card-repository");
    expect(html).toContain("data-github-card-body");
    expect(html).toContain(`title="@${commitSha}"`);
    expect(html).toContain("max-width:100%");
    expect(html).toContain("overflow-wrap:anywhere");
    expect(html).toContain("text-overflow:ellipsis");
  });
});
