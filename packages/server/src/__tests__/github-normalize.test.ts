import type { WebhookSource } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { extractMentions, normalizeGithubEvent } from "../services/github-normalize.js";

const source: WebhookSource = {
  kind: "github-app-installation",
  installationId: 99,
  organizationId: "org-uuid",
};

const senderUser = { login: "alice", type: "User" };
const repository = { full_name: "owner/repo" };

function normalize(eventType: string, payload: unknown, deliveryId: string | null = "d-1") {
  return normalizeGithubEvent(eventType, payload, source, deliveryId);
}

describe("extractMentions", () => {
  it("captures unique lowercased @mentions", () => {
    expect(extractMentions("hi @Alice and @bob, also @ALICE").sort()).toEqual(["alice", "bob"]);
  });

  it("skips team mentions (@org/team)", () => {
    expect(extractMentions("ping @owner/team and @charlie").sort()).toEqual(["charlie"]);
  });

  it("ignores emails", () => {
    expect(extractMentions("see user@example.com please")).toEqual([]);
  });

  it("returns [] for null/empty", () => {
    expect(extractMentions(null)).toEqual([]);
    expect(extractMentions("")).toEqual([]);
  });
});

describe("normalizeGithubEvent — pull_request", () => {
  it("opened: kind=opened with mentions + assignees + relatedRefs (reviewers deliberately excluded; see review_requested)", () => {
    const event = normalize("pull_request", {
      action: "opened",
      sender: senderUser,
      repository,
      pull_request: {
        number: 10,
        title: "Refactor inbox",
        html_url: "https://github.com/owner/repo/pull/10",
        body: "Closes #42. Hey @bob",
        requested_reviewers: [{ login: "Carol" }],
        assignees: [{ login: "Dave" }],
      },
    });
    expect(event).not.toBeNull();
    if (!event) return;
    expect(event.entity).toEqual({
      type: "pull_request",
      repo: "owner/repo",
      key: "owner/repo#10",
      title: "Refactor inbox",
      url: "https://github.com/owner/repo/pull/10",
    });
    expect(event.kind).toBe("opened");
    // Reviewer (carol) is NOT in involves — GitHub emits a separate
    // review_requested event per reviewer at PR creation, which is the
    // canonical notification path. Collecting it here too would double-fire.
    expect(event.involves).toEqual([
      { githubLogin: "dave", reason: "assigned" },
      { githubLogin: "bob", reason: "mentioned" },
    ]);
    expect(event.relatedRefs).toEqual([{ type: "issue", key: "owner/repo#42" }]);
    expect(event.actor).toEqual({ githubLogin: "alice", isBot: false });
    expect(event.rawEventType).toBe("pull_request");
    expect(event.rawAction).toBe("opened");
    expect(event.surface.title).toBe("PR #10: Refactor inbox");
  });

  it("synchronize: kind=synchronized with empty involves (Bug 1: no longer silenced)", () => {
    const event = normalize("pull_request", {
      action: "synchronize",
      sender: senderUser,
      repository,
      pull_request: {
        number: 10,
        title: "Refactor inbox",
        html_url: "https://github.com/owner/repo/pull/10",
        body: "",
      },
    });
    expect(event?.kind).toBe("synchronized");
    expect(event?.involves).toEqual([]);
  });

  it("review_requested with requested_reviewer.login → involves[review_requested]", () => {
    const event = normalize("pull_request", {
      action: "review_requested",
      sender: senderUser,
      repository,
      pull_request: { number: 10, title: "Refactor", html_url: "https://github.com/owner/repo/pull/10" },
      requested_reviewer: { login: "Erin" },
    });
    expect(event?.kind).toBe("review_requested");
    expect(event?.involves).toEqual([{ githubLogin: "erin", reason: "review_requested" }]);
  });

  it("review_requested with requested_team (no requested_reviewer.login) → involves=[]", () => {
    const event = normalize("pull_request", {
      action: "review_requested",
      sender: senderUser,
      repository,
      pull_request: { number: 10, title: "Refactor", html_url: "https://github.com/owner/repo/pull/10" },
      requested_team: { name: "core" },
    });
    expect(event?.kind).toBe("review_requested");
    expect(event?.involves).toEqual([]);
  });

  it("review_request_removed → null (do not notify)", () => {
    expect(
      normalize("pull_request", {
        action: "review_request_removed",
        sender: senderUser,
        repository,
        pull_request: { number: 10 },
      }),
    ).toBeNull();
  });

  it("ready_for_review → kind=review_requested with all current reviewers as involves", () => {
    const event = normalize("pull_request", {
      action: "ready_for_review",
      sender: senderUser,
      repository,
      pull_request: {
        number: 10,
        title: "Refactor",
        html_url: "https://github.com/owner/repo/pull/10",
        body: "",
        requested_reviewers: [{ login: "Carol" }, { login: "Erin" }],
      },
    });
    expect(event?.kind).toBe("review_requested");
    expect(event?.involves).toEqual([
      { githubLogin: "carol", reason: "review_requested" },
      { githubLogin: "erin", reason: "review_requested" },
    ]);
  });

  it("ready_for_review with no reviewers → null (avoid content-less subscribed-path noise)", () => {
    expect(
      normalize("pull_request", {
        action: "ready_for_review",
        sender: senderUser,
        repository,
        pull_request: {
          number: 10,
          title: "Refactor",
          html_url: "https://github.com/owner/repo/pull/10",
          body: "",
        },
      }),
    ).toBeNull();
  });

  it("assigned → kind=assigned with the newly assigned login (post-creation only)", () => {
    const event = normalize("pull_request", {
      action: "assigned",
      sender: senderUser,
      repository,
      pull_request: { number: 10, title: "Refactor", html_url: "https://github.com/owner/repo/pull/10" },
      assignee: { login: "Dave" },
    });
    expect(event?.kind).toBe("assigned");
    expect(event?.involves).toEqual([{ githubLogin: "dave", reason: "assigned" }]);
  });

  it("assigned with no assignee.login → null", () => {
    expect(
      normalize("pull_request", {
        action: "assigned",
        sender: senderUser,
        repository,
        pull_request: { number: 10, title: "Refactor", html_url: "https://github.com/owner/repo/pull/10" },
      }),
    ).toBeNull();
  });

  it("closed (merged=true) → null (PR state machine, not code review concern)", () => {
    expect(
      normalize("pull_request", {
        action: "closed",
        sender: senderUser,
        repository,
        pull_request: { number: 10, merged: true },
      }),
    ).toBeNull();
  });

  it("closed (merged=false) → null", () => {
    expect(
      normalize("pull_request", {
        action: "closed",
        sender: senderUser,
        repository,
        pull_request: { number: 10, merged: false },
      }),
    ).toBeNull();
  });

  it("reopened → null", () => {
    expect(
      normalize("pull_request", {
        action: "reopened",
        sender: senderUser,
        repository,
        pull_request: { number: 10 },
      }),
    ).toBeNull();
  });

  it("converted_to_draft → null", () => {
    expect(
      normalize("pull_request", {
        action: "converted_to_draft",
        sender: senderUser,
        repository,
        pull_request: { number: 10 },
      }),
    ).toBeNull();
  });

  it("labeled → null", () => {
    expect(
      normalize("pull_request", {
        action: "labeled",
        sender: senderUser,
        repository,
        pull_request: { number: 10 },
      }),
    ).toBeNull();
  });
});

describe("normalizeGithubEvent — pull_request_review / review_comment", () => {
  it("review.submitted → kind=reviewed with mentions in review.body", () => {
    const event = normalize("pull_request_review", {
      action: "submitted",
      sender: { login: "Carol", type: "User" },
      repository,
      pull_request: { number: 10, title: "X", html_url: "https://github.com/owner/repo/pull/10" },
      review: {
        body: "lgtm, @bob check please",
        html_url: "https://github.com/owner/repo/pull/10#pullrequestreview-1",
      },
    });
    expect(event?.kind).toBe("reviewed");
    expect(event?.involves).toEqual([{ githubLogin: "bob", reason: "mentioned" }]);
    expect(event?.entity.type).toBe("pull_request");
  });

  it("pull_request_review_comment.created → kind=review_comment", () => {
    const event = normalize("pull_request_review_comment", {
      action: "created",
      sender: senderUser,
      repository,
      pull_request: { number: 10, title: "X", html_url: "https://github.com/owner/repo/pull/10" },
      comment: { body: "nit", html_url: "https://github.com/owner/repo/pull/10#discussion_r1" },
    });
    expect(event?.kind).toBe("review_comment");
  });
});

describe("normalizeGithubEvent — issue_comment (Bug 3 core fix)", () => {
  it("issue_comment on a PR → entity.type=pull_request, kind=commented", () => {
    const event = normalize("issue_comment", {
      action: "created",
      sender: senderUser,
      repository,
      issue: {
        number: 316,
        title: "Improve onboarding",
        html_url: "https://github.com/owner/repo/issues/316",
        pull_request: { html_url: "https://github.com/owner/repo/pull/316" },
      },
      comment: { body: "ack @bob", html_url: "https://github.com/owner/repo/pull/316#issuecomment-1" },
    });
    expect(event?.entity).toEqual({
      type: "pull_request",
      repo: "owner/repo",
      key: "owner/repo#316",
      title: "Improve onboarding",
      url: "https://github.com/owner/repo/pull/316",
    });
    expect(event?.kind).toBe("commented");
    expect(event?.involves).toEqual([{ githubLogin: "bob", reason: "mentioned" }]);
    expect(event?.surface.title).toBe("PR #316: Improve onboarding");
  });

  it("issue_comment on a real issue → entity.type=issue", () => {
    const event = normalize("issue_comment", {
      action: "created",
      sender: senderUser,
      repository,
      issue: { number: 42, title: "Bug X", html_url: "https://github.com/owner/repo/issues/42" },
      comment: { body: "hi", html_url: "https://github.com/owner/repo/issues/42#issuecomment-1" },
    });
    expect(event?.entity.type).toBe("issue");
    expect(event?.surface.title).toBe("Issue #42: Bug X");
  });
});

describe("normalizeGithubEvent — issues", () => {
  it("opened → kind=opened with assignees + mentions", () => {
    const event = normalize("issues", {
      action: "opened",
      sender: senderUser,
      repository,
      issue: {
        number: 42,
        title: "Bug X",
        html_url: "https://github.com/owner/repo/issues/42",
        body: "cc @bob",
        assignees: [{ login: "Carol" }],
      },
    });
    expect(event?.kind).toBe("opened");
    expect(event?.involves).toEqual([
      { githubLogin: "carol", reason: "assigned" },
      { githubLogin: "bob", reason: "mentioned" },
    ]);
  });

  it("assigned → kind=assigned with assignee-only involves", () => {
    const event = normalize("issues", {
      action: "assigned",
      sender: senderUser,
      repository,
      issue: { number: 42, title: "Bug X", html_url: "https://github.com/owner/repo/issues/42" },
      assignee: { login: "Dave" },
    });
    expect(event?.kind).toBe("assigned");
    expect(event?.involves).toEqual([{ githubLogin: "dave", reason: "assigned" }]);
  });

  it("assigned with no assignee.login → null", () => {
    expect(
      normalize("issues", {
        action: "assigned",
        sender: senderUser,
        repository,
        issue: { number: 42, title: "Bug X", html_url: "https://github.com/owner/repo/issues/42" },
      }),
    ).toBeNull();
  });

  it("labeled → null", () => {
    expect(normalize("issues", { action: "labeled", sender: senderUser, repository, issue: { number: 1 } })).toBeNull();
  });
});

describe("normalizeGithubEvent — discussion / discussion_comment / commit_comment", () => {
  it("discussion.created → kind=opened with body mentions", () => {
    const event = normalize("discussion", {
      action: "created",
      sender: senderUser,
      repository,
      discussion: {
        number: 9,
        title: "RFC",
        html_url: "https://github.com/owner/repo/discussions/9",
        body: "thoughts @bob?",
      },
    });
    expect(event?.entity.type).toBe("discussion");
    expect(event?.entity.key).toBe("owner/repo#9");
    expect(event?.kind).toBe("opened");
    expect(event?.involves).toEqual([{ githubLogin: "bob", reason: "mentioned" }]);
  });

  it("discussion_comment.created → kind=commented", () => {
    const event = normalize("discussion_comment", {
      action: "created",
      sender: senderUser,
      repository,
      discussion: { number: 9, title: "RFC", html_url: "https://github.com/owner/repo/discussions/9" },
      comment: { body: "yes", html_url: "https://github.com/owner/repo/discussions/9#discussioncomment-1" },
    });
    expect(event?.entity).toMatchObject({ type: "discussion", key: "owner/repo#9" });
    expect(event?.kind).toBe("commented");
  });

  it("commit_comment.created → entity is commit keyed on sha", () => {
    const event = normalize("commit_comment", {
      action: "created",
      sender: senderUser,
      repository,
      comment: {
        body: "nit",
        commit_id: "abc1234",
        html_url: "https://github.com/owner/repo/commit/abc1234#comment-1",
      },
    });
    expect(event?.entity).toEqual({
      type: "commit",
      repo: "owner/repo",
      key: "owner/repo@abc1234",
      url: "https://github.com/owner/repo/commit/abc1234#comment-1",
    });
    expect(event?.kind).toBe("commit_commented");
  });
});

describe("normalizeGithubEvent — out-of-scope event types & malformed payloads", () => {
  it("push → null", () => {
    expect(normalize("push", { repository, sender: senderUser })).toBeNull();
  });

  it("workflow_run → null", () => {
    expect(normalize("workflow_run", { action: "completed", repository, sender: senderUser })).toBeNull();
  });

  it("missing repository → null", () => {
    expect(
      normalize("pull_request", {
        action: "opened",
        sender: senderUser,
        pull_request: { number: 1 },
      }),
    ).toBeNull();
  });

  it("missing sender → null", () => {
    expect(
      normalize("pull_request", {
        action: "opened",
        repository,
        pull_request: { number: 1, title: "x", html_url: "u", body: "" },
      }),
    ).toBeNull();
  });

  it("Bot sender carries actor.isBot=true (no longer silenced; DP8)", () => {
    const event = normalize("issues", {
      action: "opened",
      sender: { login: "dependabot[bot]", type: "Bot" },
      repository,
      issue: {
        number: 99,
        title: "Bump version",
        html_url: "https://github.com/owner/repo/issues/99",
        body: "",
      },
    });
    expect(event).not.toBeNull();
    expect(event?.actor).toEqual({ githubLogin: "dependabot[bot]", isBot: true });
    expect(event?.involves).toEqual([]);
  });
});
