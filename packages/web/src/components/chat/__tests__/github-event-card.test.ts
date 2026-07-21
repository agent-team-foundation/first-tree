import { describe, expect, it } from "vitest";
import {
  isGithubEventCardContent,
  isGithubSystemSenderMetadata,
  isTrustedGithubDispatcherMessage,
  shortEntityNumber,
  stripEntityPrefix,
} from "../github-event-card.js";

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
    expect(isGithubSystemSenderMetadata({ systemSender: "other" })).toBe(false);
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

/**
 * The chat view re-attributes a row to the synthetic "GitHub" sender only
 * when every signal lines up. These tests pin the conjunctive guard so a
 * future change cannot weaken it back to a metadata-only check without
 * lighting up red — the metadata field alone is forgeable (per the
 * external code review on this PR), so each test exercises one required
 * property of the card or Context Reviewer run trust branch.
 */
const trustedMsg = {
  source: "github",
  format: "card",
  content: validCard,
  metadata: { systemSender: "github" },
};

const trustedContextReviewMsg = {
  source: "github",
  format: "markdown",
  content: "Review this Context Tree pull request head.",
  metadata: {
    source: "github",
    contextTreeReviewer: true,
    contextReviewRunId: "run-42",
    contextReviewRepository: "owner/repo",
    contextReviewPrNumber: 42,
    contextReviewOrganizationId: "org-1",
    contextReviewReviewerAgentUuid: "reviewer-1",
    contextReviewReviewerManagerHumanAgentId: "human-1",
    contextReviewSubmission: { state: "pending" },
  },
};

describe("isTrustedGithubDispatcherMessage", () => {
  it("accepts a message that matches every dispatcher signal", () => {
    expect(isTrustedGithubDispatcherMessage(trustedMsg)).toBe(true);
  });

  it("accepts server-authored Context Reviewer run Markdown", () => {
    expect(isTrustedGithubDispatcherMessage(trustedContextReviewMsg)).toBe(true);
  });

  it.each([
    { state: "pending" },
    {
      state: "submitting",
      payloadHash: "hash",
      attemptId: "attempt-1",
      reviewedHead: "a".repeat(40),
      event: "APPROVE",
      claimedAt: "2026-07-21T00:00:00.000Z",
      reviewerClientId: "client-1",
    },
    {
      state: "unknown",
      payloadHash: "hash",
      attemptId: "attempt-1",
      reviewedHead: "a".repeat(40),
      event: "COMMENT",
      failedAt: "2026-07-21T00:00:00.000Z",
      reviewerClientId: "client-1",
    },
    {
      state: "failed",
      payloadHash: "hash",
      code: "CONTEXT_REVIEW_GITHUB_REJECTED",
      failedAt: "2026-07-21T00:00:00.000Z",
    },
    {
      state: "submitted",
      payloadHash: "hash",
      reviewedHead: "a".repeat(40),
      event: "APPROVE",
      reviewId: 42,
      reviewUrl: "https://github.com/owner/repo/pull/42#pullrequestreview-42",
      appActor: "first-tree[bot]",
      submittedAt: "2026-07-21T00:00:00.000Z",
      reviewerAgentUuid: "reviewer-1",
      reviewerManagerHumanAgentId: "human-1",
      reviewerClientId: "client-1",
      reviewerManagerGithubLogin: null,
    },
  ])("keeps Context Reviewer Markdown trusted after publication enters $state", (contextReviewSubmission) => {
    expect(
      isTrustedGithubDispatcherMessage({
        ...trustedContextReviewMsg,
        metadata: { ...trustedContextReviewMsg.metadata, contextReviewSubmission },
      }),
    ).toBe(true);
  });

  it("rejects when source is not 'github' (agent CLI / web / api send)", () => {
    for (const source of ["api", "cli", "web", "other", null, undefined]) {
      expect(isTrustedGithubDispatcherMessage({ ...trustedMsg, source })).toBe(false);
    }
  });

  it("rejects a card payload when its format is not 'card'", () => {
    for (const format of ["text", "markdown", "question", "file"]) {
      expect(isTrustedGithubDispatcherMessage({ ...trustedMsg, format })).toBe(false);
    }
  });

  it("rejects when the content payload is not a valid GithubEventCard", () => {
    expect(isTrustedGithubDispatcherMessage({ ...trustedMsg, content: "hello" })).toBe(false);
    expect(isTrustedGithubDispatcherMessage({ ...trustedMsg, content: { type: "github_mention" } })).toBe(false);
  });

  it("rejects when the metadata marker is missing or wrong", () => {
    expect(isTrustedGithubDispatcherMessage({ ...trustedMsg, metadata: {} })).toBe(false);
    expect(isTrustedGithubDispatcherMessage({ ...trustedMsg, metadata: { systemSender: "other" } })).toBe(false);
    expect(isTrustedGithubDispatcherMessage({ ...trustedMsg, metadata: null })).toBe(false);
  });

  it("rejects Context Reviewer Markdown unless its complete run envelope is valid", () => {
    expect(
      isTrustedGithubDispatcherMessage({
        ...trustedContextReviewMsg,
        metadata: { source: "github", contextTreeReviewer: true },
      }),
    ).toBe(false);
    expect(
      isTrustedGithubDispatcherMessage({
        ...trustedContextReviewMsg,
        metadata: {
          ...trustedContextReviewMsg.metadata,
          contextReviewRepository: "not-a-repository",
        },
      }),
    ).toBe(false);
    expect(isTrustedGithubDispatcherMessage({ ...trustedContextReviewMsg, source: "api" })).toBe(false);
  });
});

/**
 * Server-side `entitySurfaceTitle` (services/github-normalize.ts) prefixes
 * the raw entity title with `"PR #N: "` / `"Issue #N: "` /
 * `"Discussion #N: "` / `"Commit: "`. The L1 chip already renders that
 * prefix as a badge, so the card strips it before showing the title. Pin
 * the stripping contract so a regression silently re-introduces the
 * "PR-NN: PR-NN: ..." visual duplication that motivated this change.
 * (Issue numbers in this file kept at 1-2 digits to avoid the hex-color
 * guardrail in scripts/check-design-tokens.sh.)
 */
describe("stripEntityPrefix", () => {
  it("strips PR / Issue / Discussion prefix when title matches the server format", () => {
    expect(stripEntityPrefix("PR #42: Refactor inbox", "pull_request", "#42")).toBe("Refactor inbox");
    expect(stripEntityPrefix("Issue #7: Bug in parser", "issue", "#7")).toBe("Bug in parser");
    expect(stripEntityPrefix("Discussion #9: RFC draft", "discussion", "#9")).toBe("RFC draft");
  });

  it("strips the bare prefix when entity.title was absent server-side", () => {
    // entitySurfaceTitle returns just `"PR #N"` (no colon) when entity.title is empty.
    // The chip already shows it, so render-side returns "" to hide the title element.
    expect(stripEntityPrefix("PR #42", "pull_request", "#42")).toBe("");
    expect(stripEntityPrefix("Commit", "commit", "@x")).toBe("");
  });

  it("strips Commit prefix (no number in surface title) for commits", () => {
    expect(stripEntityPrefix("Commit: Fix typo in README", "commit", "@x")).toBe("Fix typo in README");
  });

  it("returns the title as-is when the prefix does not match (older messages / schema drift)", () => {
    expect(stripEntityPrefix("Some legacy title", "pull_request", "#42")).toBe("Some legacy title");
    // Number mismatch — defensive: don't slice mid-token.
    expect(stripEntityPrefix("PR #99: Title", "pull_request", "#42")).toBe("PR #99: Title");
  });
});

/**
 * `shortEntityNumber` produces the value the L1 chip displays *and* the
 * value `stripEntityPrefix` reconstructs the head from — so the two
 * always need to agree. Discussion is the load-bearing case because older
 * persisted cards may still carry `owner/repo#discussion-N`, while the
 * canonical server key and surface title now use plain `#N`. If chip and
 * strip disagree on the discussion number format, dedupe silently fails for
 * discussion cards.
 */
describe("shortEntityNumber", () => {
  it("strips the repo prefix for issue / PR keys", () => {
    expect(shortEntityNumber("owner/repo#42", "owner/repo")).toBe("#42");
    expect(shortEntityNumber("owner/repo#7", "owner/repo")).toBe("#7");
  });

  it("keeps canonical discussion keys as #N", () => {
    expect(shortEntityNumber("owner/repo#9", "owner/repo")).toBe("#9");
  });

  it("collapses the legacy discussion-N infix so chip and surface title agree on #N", () => {
    expect(shortEntityNumber("owner/repo#discussion-9", "owner/repo")).toBe("#9");
  });

  it("keeps the full sha for commit keys (server commit title has no number)", () => {
    expect(shortEntityNumber("owner/repo@abc", "owner/repo")).toBe("@abc");
  });
});

/**
 * End-to-end integration: feed realistic `entity.key` shapes through
 * `shortEntityNumber` and into `stripEntityPrefix` the way
 * `GithubEventCardMessage` does. Catches the regression that earlier
 * unit-only tests missed — where a discussion key was being matched
 * against the wrong head (`"Discussion #discussion-9"` instead of
 * `"Discussion #9"`), leaving the title prefix un-stripped.
 */
describe("entity-key → strip integration (mirrors GithubEventCardMessage)", () => {
  const cases = [
    {
      type: "pull_request" as const,
      key: "owner/repo#42",
      title: "PR #42: Refactor inbox",
      expected: "Refactor inbox",
    },
    { type: "issue" as const, key: "owner/repo#7", title: "Issue #7: Bug in parser", expected: "Bug in parser" },
    {
      type: "discussion" as const,
      key: "owner/repo#9",
      title: "Discussion #9: RFC draft",
      expected: "RFC draft",
    },
    {
      type: "discussion" as const,
      key: "owner/repo#discussion-9",
      title: "Discussion #9: Legacy RFC draft",
      expected: "Legacy RFC draft",
    },
    { type: "commit" as const, key: "owner/repo@abc", title: "Commit: Fix typo", expected: "Fix typo" },
  ];

  for (const c of cases) {
    it(`strips the ${c.type} prefix from a realistic card`, () => {
      const entityNumber = shortEntityNumber(c.key, "owner/repo");
      expect(stripEntityPrefix(c.title, c.type, entityNumber)).toBe(c.expected);
    });
  }
});
