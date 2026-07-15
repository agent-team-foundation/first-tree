import type { ScmIngressContext } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { extractMentions, normalizeGithubEvent } from "../services/github-normalize.js";

const senderUser = { login: "alice", type: "User" };
const repository = { full_name: "owner/repo" };

function normalize(eventType: string, payload: unknown, deliveryId: string | null = "d-1") {
  const ingress: ScmIngressContext = {
    provider: "github",
    source: { organizationId: "org-uuid", externalId: "installation:99" },
    stableDeliveryId: deliveryId,
    ingressAuthority: "verified_signature",
  };
  return normalizeGithubEvent(eventType, payload, ingress);
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
      projectKey: "owner/repo",
      key: "owner/repo#10",
      title: "Refactor inbox",
      url: "https://github.com/owner/repo/pull/10",
    });
    expect(event.kind).toBe("opened");
    // Reviewer (carol) is NOT in involves — GitHub emits a separate
    // review_requested event per reviewer at PR creation, which is the
    // canonical notification path. Collecting it here too would double-fire.
    expect(event.targets).toEqual([
      { externalUsername: "dave", reason: "assigned" },
      { externalUsername: "bob", reason: "mentioned" },
    ]);
    expect(event.relatedRefs).toEqual([{ type: "issue", key: "owner/repo#42" }]);
    expect(event.actor).toEqual({ externalUsername: "alice", isBot: false });
    expect(event.eventType).toBe("pull_request");
    expect(event.action).toBe("opened");
    expect(event).toMatchObject({
      provider: "github",
      source: { organizationId: "org-uuid", externalId: "installation:99" },
      stableDeliveryId: "d-1",
      ingressAuthority: "verified_signature",
    });
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
    expect(event?.targets).toEqual([]);
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
    expect(event?.targets).toEqual([{ externalUsername: "erin", reason: "review_requested" }]);
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
    expect(event?.targets).toEqual([]);
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

  it("edited: kind=edited with mentions and fallback surface fields", () => {
    const event = normalize("pull_request", {
      action: "edited",
      sender: senderUser,
      repository,
      pull_request: {
        number: 11,
        body: "Updated notes for @Bob and @bob.",
      },
    });

    expect(event?.kind).toBe("edited");
    expect(event?.entity).toEqual({
      type: "pull_request",
      projectKey: "owner/repo",
      key: "owner/repo#11",
      title: undefined,
      url: undefined,
    });
    expect(event?.surface).toEqual({
      title: "PR #11",
      body: "Updated notes for @Bob and @bob.",
      url: "",
    });
    expect(event?.targets).toEqual([{ externalUsername: "bob", reason: "mentioned" }]);
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
    expect(event?.targets).toEqual([
      { externalUsername: "carol", reason: "review_requested" },
      { externalUsername: "erin", reason: "review_requested" },
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
    expect(event?.targets).toEqual([{ externalUsername: "dave", reason: "assigned" }]);
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
    expect(event?.targets).toEqual([{ externalUsername: "bob", reason: "mentioned" }]);
    expect(event?.entity.type).toBe("pull_request");
  });

  it("review.dismissed and edited are normalized as reviewed", () => {
    for (const action of ["dismissed", "edited"]) {
      const event = normalize("pull_request_review", {
        action,
        sender: senderUser,
        repository,
        pull_request: { number: 10 },
        review: { body: "", html_url: "" },
      });

      expect(event?.kind).toBe("reviewed");
      expect(event?.surface.title).toBe("PR #10");
      expect(event?.surface.url).toBe("");
    }
  });

  it("drops malformed pull_request_review payloads", () => {
    expect(
      normalize("pull_request_review", {
        action: "submitted",
        sender: senderUser,
        repository,
        review: { body: "missing pr" },
      }),
    ).toBeNull();
    expect(
      normalize("pull_request_review", {
        action: "submitted",
        sender: senderUser,
        repository,
        pull_request: { number: 10 },
      }),
    ).toBeNull();
    expect(
      normalize("pull_request_review", {
        action: "submitted",
        sender: senderUser,
        repository,
        pull_request: { number: "10" },
        review: { body: "bad number" },
      }),
    ).toBeNull();
    expect(
      normalize("pull_request_review", {
        action: "commented",
        sender: senderUser,
        repository,
        pull_request: { number: 10 },
        review: { body: "unsupported action" },
      }),
    ).toBeNull();
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

  it("pull_request_review_comment.edited uses fallback surface fields", () => {
    const event = normalize("pull_request_review_comment", {
      action: "edited",
      sender: senderUser,
      repository,
      pull_request: { number: 10 },
      comment: { body: "follow-up @Erin" },
    });

    expect(event?.kind).toBe("review_comment");
    expect(event?.surface).toEqual({
      title: "PR #10",
      body: "follow-up @Erin",
      url: "",
    });
    expect(event?.targets).toEqual([{ externalUsername: "erin", reason: "mentioned" }]);
  });

  it("drops malformed pull_request_review_comment payloads", () => {
    expect(
      normalize("pull_request_review_comment", {
        action: "created",
        sender: senderUser,
        repository,
        comment: { body: "missing pr" },
      }),
    ).toBeNull();
    expect(
      normalize("pull_request_review_comment", {
        action: "created",
        sender: senderUser,
        repository,
        pull_request: { number: 10 },
      }),
    ).toBeNull();
    expect(
      normalize("pull_request_review_comment", {
        action: "created",
        sender: senderUser,
        repository,
        pull_request: { number: Number.NaN },
        comment: { body: "bad number" },
      }),
    ).toBeNull();
    expect(
      normalize("pull_request_review_comment", {
        action: "deleted",
        sender: senderUser,
        repository,
        pull_request: { number: 10 },
        comment: { body: "unsupported action" },
      }),
    ).toBeNull();
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
      projectKey: "owner/repo",
      key: "owner/repo#316",
      title: "Improve onboarding",
      url: "https://github.com/owner/repo/pull/316",
    });
    expect(event?.kind).toBe("commented");
    expect(event?.targets).toEqual([{ externalUsername: "bob", reason: "mentioned" }]);
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

  it("issue_comment.edited uses fallback issue title and URL", () => {
    const event = normalize("issue_comment", {
      action: "edited",
      sender: senderUser,
      repository,
      issue: { number: 43 },
      comment: { body: "updated @Carol" },
    });

    expect(event?.kind).toBe("commented");
    expect(event?.surface).toEqual({
      title: "Issue #43",
      body: "updated @Carol",
      url: "",
    });
    expect(event?.targets).toEqual([{ externalUsername: "carol", reason: "mentioned" }]);
  });

  it("drops malformed issue_comment payloads", () => {
    expect(
      normalize("issue_comment", {
        action: "created",
        sender: senderUser,
        repository,
        comment: { body: "missing issue" },
      }),
    ).toBeNull();
    expect(
      normalize("issue_comment", {
        action: "created",
        sender: senderUser,
        repository,
        issue: { number: 42 },
      }),
    ).toBeNull();
    expect(
      normalize("issue_comment", {
        action: "created",
        sender: senderUser,
        repository,
        issue: { number: null },
        comment: { body: "bad issue number" },
      }),
    ).toBeNull();
    expect(
      normalize("issue_comment", {
        action: "deleted",
        sender: senderUser,
        repository,
        issue: { number: 42 },
        comment: { body: "unsupported action" },
      }),
    ).toBeNull();
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
    expect(event?.targets).toEqual([
      { externalUsername: "carol", reason: "assigned" },
      { externalUsername: "bob", reason: "mentioned" },
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
    expect(event?.targets).toEqual([{ externalUsername: "dave", reason: "assigned" }]);
  });

  it("edited, closed, and reopened normalize issue state changes", () => {
    const edited = normalize("issues", {
      action: "edited",
      sender: senderUser,
      repository,
      issue: {
        number: 42,
        html_url: "https://github.com/owner/repo/issues/42",
        body: "new details @Bob",
      },
    });
    expect(edited?.kind).toBe("edited");
    expect(edited?.surface.title).toBe("Issue #42");
    expect(edited?.targets).toEqual([{ externalUsername: "bob", reason: "mentioned" }]);

    const closed = normalize("issues", {
      action: "closed",
      sender: senderUser,
      repository,
      issue: { number: 42, title: "Bug X", html_url: "https://github.com/owner/repo/issues/42" },
    });
    expect(closed?.kind).toBe("closed");
    expect(closed?.targets).toEqual([]);

    const reopened = normalize("issues", {
      action: "reopened",
      sender: senderUser,
      repository,
      issue: { number: 42, title: "Bug X", html_url: "https://github.com/owner/repo/issues/42" },
    });
    expect(reopened?.kind).toBe("reopened");
    expect(reopened?.targets).toEqual([]);
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

  it("drops malformed issues payloads", () => {
    expect(normalize("issues", { action: "opened", sender: senderUser, repository })).toBeNull();
    expect(
      normalize("issues", {
        action: "opened",
        sender: senderUser,
        repository,
        issue: { number: "42", title: "Bad number" },
      }),
    ).toBeNull();
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
    expect(event?.targets).toEqual([{ externalUsername: "bob", reason: "mentioned" }]);
  });

  it("discussion state changes normalize to edited, closed, reopened, or other", () => {
    const edited = normalize("discussion", {
      action: "edited",
      sender: senderUser,
      repository,
      discussion: { number: 9, body: "updated @Carol" },
    });
    expect(edited?.kind).toBe("edited");
    expect(edited?.surface.title).toBe("Discussion #9");
    expect(edited?.targets).toEqual([{ externalUsername: "carol", reason: "mentioned" }]);

    const closed = normalize("discussion", {
      action: "closed",
      sender: senderUser,
      repository,
      discussion: { number: 9, title: "RFC" },
    });
    expect(closed?.kind).toBe("closed");

    const reopened = normalize("discussion", {
      action: "reopened",
      sender: senderUser,
      repository,
      discussion: { number: 9, title: "RFC" },
    });
    expect(reopened?.kind).toBe("reopened");

    for (const action of ["answered", "unanswered"]) {
      const event = normalize("discussion", {
        action,
        sender: senderUser,
        repository,
        discussion: { number: 9, title: "RFC", html_url: "https://github.com/owner/repo/discussions/9" },
      });
      expect(event?.kind).toBe("other");
      expect(event?.targets).toEqual([]);
    }
  });

  it("drops malformed discussion payloads", () => {
    expect(normalize("discussion", { action: "created", sender: senderUser, repository })).toBeNull();
    expect(
      normalize("discussion", {
        action: "created",
        sender: senderUser,
        repository,
        discussion: { number: "9", title: "Bad number" },
      }),
    ).toBeNull();
    expect(
      normalize("discussion", {
        action: "pinned",
        sender: senderUser,
        repository,
        discussion: { number: 9 },
      }),
    ).toBeNull();
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

  it("discussion_comment.edited uses fallback URL and title", () => {
    const event = normalize("discussion_comment", {
      action: "edited",
      sender: senderUser,
      repository,
      discussion: { number: 9 },
      comment: { body: "edit @Dave" },
    });

    expect(event?.kind).toBe("commented");
    expect(event?.surface).toEqual({
      title: "Discussion #9",
      body: "edit @Dave",
      url: "",
    });
    expect(event?.targets).toEqual([{ externalUsername: "dave", reason: "mentioned" }]);
  });

  it("drops malformed discussion_comment payloads", () => {
    expect(
      normalize("discussion_comment", {
        action: "created",
        sender: senderUser,
        repository,
        comment: { body: "missing discussion" },
      }),
    ).toBeNull();
    expect(
      normalize("discussion_comment", {
        action: "created",
        sender: senderUser,
        repository,
        discussion: { number: 9 },
      }),
    ).toBeNull();
    expect(
      normalize("discussion_comment", {
        action: "created",
        sender: senderUser,
        repository,
        discussion: { number: Number.POSITIVE_INFINITY },
        comment: { body: "bad number" },
      }),
    ).toBeNull();
    expect(
      normalize("discussion_comment", {
        action: "deleted",
        sender: senderUser,
        repository,
        discussion: { number: 9 },
        comment: { body: "unsupported action" },
      }),
    ).toBeNull();
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
      projectKey: "owner/repo",
      key: "owner/repo@abc1234",
      url: "https://github.com/owner/repo/commit/abc1234#comment-1",
    });
    expect(event?.kind).toBe("commit_commented");
  });

  it("commit_comment carries mentions and falls back when optional fields are empty", () => {
    const event = normalize("commit_comment", {
      action: "created",
      sender: senderUser,
      repository,
      comment: {
        body: "please inspect @Erin",
        commit_id: "def5678",
        html_url: "",
      },
    });

    expect(event?.surface).toEqual({
      title: "Commit",
      body: "please inspect @Erin",
      url: "",
    });
    expect(event?.targets).toEqual([{ externalUsername: "erin", reason: "mentioned" }]);
  });

  it("drops malformed commit_comment payloads", () => {
    expect(normalize("commit_comment", { action: "created", sender: senderUser, repository })).toBeNull();
    expect(
      normalize("commit_comment", {
        action: "created",
        sender: senderUser,
        repository,
        comment: { body: "missing sha" },
      }),
    ).toBeNull();
    expect(
      normalize("commit_comment", {
        action: "edited",
        sender: senderUser,
        repository,
        comment: { commit_id: "abc1234" },
      }),
    ).toBeNull();
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

  it("non-object, invalid sender, and invalid repository payloads return null", () => {
    expect(normalize("issues", null)).toBeNull();
    expect(normalize("issues", [])).toBeNull();
    expect(
      normalize("issues", {
        action: "opened",
        sender: { login: "" },
        repository,
        issue: { number: 1 },
      }),
    ).toBeNull();
    expect(
      normalize("issues", {
        action: "opened",
        sender: "alice",
        repository,
        issue: { number: 1 },
      }),
    ).toBeNull();
    expect(
      normalize("issues", {
        action: "opened",
        sender: senderUser,
        repository: { full_name: "" },
        issue: { number: 1 },
      }),
    ).toBeNull();
    expect(
      normalize("issues", {
        action: "opened",
        sender: senderUser,
        repository: "owner/repo",
        issue: { number: 1 },
      }),
    ).toBeNull();
  });

  it("handles missing action as an unsupported action", () => {
    expect(
      normalize("pull_request", {
        sender: senderUser,
        repository,
        pull_request: { number: 10 },
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
    expect(event?.actor).toEqual({ externalUsername: "dependabot[bot]", isBot: true });
    expect(event?.targets).toEqual([]);
  });
});
