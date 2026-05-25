import { describe, expect, it } from "vitest";
import { isGithubEventCardContent, isGithubSystemSenderMetadata } from "../github-event-card.js";

/**
 * Pin the type guard so the chat-view dispatch logic at chat-view.tsx can
 * safely narrow `MessageWithDelivery.content` (which is `unknown` at the
 * wire level) before handing it to `GithubEventCardMessage`. A regression
 * here either renders the JSON `<pre>` fallback for a real github event
 * (UX regression) or crashes on a malformed payload (robustness
 * regression).
 */

const validCard = {
  type: "github_event",
  reason: "mentioned",
  event: "issue_comment",
  action: "created",
  kind: "commented",
  repository: "owner/repo",
  sender: "@octocat",
  title: "Fix the bug",
  body: "@me please review",
  url: "https://github.com/owner/repo/issues/1",
  entity: {
    type: "issue",
    key: "#1",
    url: "https://github.com/owner/repo/issues/1",
  },
};

describe("isGithubEventCardContent", () => {
  it("accepts a valid GithubEventCard", () => {
    expect(isGithubEventCardContent(validCard)).toBe(true);
  });

  it("accepts all four reason values", () => {
    for (const reason of ["mentioned", "review_requested", "assigned", "subscribed"] as const) {
      expect(isGithubEventCardContent({ ...validCard, reason })).toBe(true);
    }
  });

  it("accepts mentionedUser when provided", () => {
    expect(isGithubEventCardContent({ ...validCard, mentionedUser: "@me" })).toBe(true);
  });

  it("accepts a null entity.url (GitHub sometimes omits it)", () => {
    expect(isGithubEventCardContent({ ...validCard, entity: { ...validCard.entity, url: null } })).toBe(true);
  });

  it("accepts a null action (synthetic events)", () => {
    expect(isGithubEventCardContent({ ...validCard, action: null })).toBe(true);
  });

  it("rejects when type discriminator is missing or wrong", () => {
    expect(isGithubEventCardContent({ ...validCard, type: "github_mention" })).toBe(false);
    const { type: _omit, ...withoutType } = validCard;
    expect(isGithubEventCardContent(withoutType)).toBe(false);
  });

  it("rejects an unknown reason value", () => {
    expect(isGithubEventCardContent({ ...validCard, reason: "cc-d" })).toBe(false);
  });

  it("rejects when required string fields are missing", () => {
    const { entity: _e, ...noEntity } = validCard;
    expect(isGithubEventCardContent(noEntity)).toBe(false);
    expect(isGithubEventCardContent({ ...validCard, entity: { type: "issue", key: "", url: null } })).toBe(false);
  });

  it("rejects non-object inputs", () => {
    expect(isGithubEventCardContent(null)).toBe(false);
    expect(isGithubEventCardContent(undefined)).toBe(false);
    expect(isGithubEventCardContent("github_event")).toBe(false);
    expect(isGithubEventCardContent(42)).toBe(false);
  });

  it("rejects question / question_answer payloads (no cross-format aliasing)", () => {
    expect(isGithubEventCardContent({ correlationId: "tu_1", questions: [], allowFreeText: true })).toBe(false);
    expect(isGithubEventCardContent({ correlationId: "tu_1", answers: {} })).toBe(false);
  });
});

/**
 * Pins the metadata gate that controls when the chat view re-attributes a
 * row to the synthetic "GitHub" sender. A regression here either fails to
 * override the human-agent attribution for legitimate dispatcher cards
 * (UX regression — recipient sees their own avatar on the card) or
 * accepts a stray `systemSender` from non-GitHub paths (impersonation
 * risk). The check is intentionally strict on both shape and value.
 */
describe("isGithubSystemSenderMetadata", () => {
  it("accepts metadata with systemSender === 'github'", () => {
    expect(isGithubSystemSenderMetadata({ systemSender: "github" })).toBe(true);
    expect(isGithubSystemSenderMetadata({ systemSender: "github", reason: "mentioned" })).toBe(true);
  });

  it("rejects other systemSender values and bare metadata", () => {
    expect(isGithubSystemSenderMetadata({ systemSender: "feishu" })).toBe(false);
    expect(isGithubSystemSenderMetadata({ systemSender: "" })).toBe(false);
    expect(isGithubSystemSenderMetadata({ source: "github" })).toBe(false);
    expect(isGithubSystemSenderMetadata({})).toBe(false);
  });

  it("rejects non-object inputs without throwing", () => {
    expect(isGithubSystemSenderMetadata(null)).toBe(false);
    expect(isGithubSystemSenderMetadata(undefined)).toBe(false);
    expect(isGithubSystemSenderMetadata("github")).toBe(false);
    expect(isGithubSystemSenderMetadata(42)).toBe(false);
  });
});
