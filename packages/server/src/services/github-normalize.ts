import type {
  InvolveReason,
  NormalizedEventKind,
  NormalizedScmEvent,
  ScmEntityObservation,
  ScmIngressContext,
  ScmNormalizedWebhook,
} from "@first-tree/shared";
import { extractEventEntity, type GithubEntity, isRecord } from "../api/webhooks/github-entity.js";
import type { EntityStateSeed } from "./github-entity-state.js";
import { parseSameProjectClosingIssueRefs } from "./scm-related-refs.js";

const MENTION_REGEX = /(?<!\w)@([a-zA-Z0-9][\w-]*)(\/)?/g;

/** Lower-cased unique @mention logins from free-form text. Skips team
 * mentions (`@org/team`) to match the agent-name lookup downstream
 * (`agents.name` doesn't carry slashes). */
export function extractMentions(text: string | null | undefined): string[] {
  if (!text) return [];
  const names = new Set<string>();
  for (const m of text.matchAll(MENTION_REGEX)) {
    if (m[2]) continue;
    const login = m[1];
    if (!login) continue;
    names.add(login.toLowerCase());
  }
  return [...names];
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pullRequestStateFromPayload(pr: Record<string, unknown>, action: string): EntityStateSeed["state"] {
  const state = readString(pr.state);
  if (action === "closed" || state === "closed") {
    return pr.merged === true ? "merged" : "closed";
  }
  return pr.draft === true ? "draft" : "open";
}

function issueStateFromPayload(issue: Record<string, unknown>, action: string): EntityStateSeed["state"] {
  const state = readString(issue.state);
  return action === "closed" || state === "closed" ? "closed" : "open";
}

function pullRequestStateFromIssuePayload(issue: Record<string, unknown>, action: string): EntityStateSeed["state"] {
  const state = readString(issue.state);
  if (action === "closed" || state === "closed") {
    const pr = isRecord(issue.pull_request) ? issue.pull_request : null;
    return readString(pr?.merged_at) ? "merged" : "closed";
  }
  return issue.draft === true ? "draft" : "open";
}

function resolveEntityStateSeed(
  eventType: string,
  action: string,
  payload: Record<string, unknown>,
  repoFullName: string,
): EntityStateSeed | null {
  if (
    eventType === "pull_request" ||
    eventType === "pull_request_review" ||
    eventType === "pull_request_review_comment"
  ) {
    const pr = isRecord(payload.pull_request) ? payload.pull_request : null;
    const number = readNumber(pr?.number);
    if (!pr || number === null) return null;
    return {
      entityType: "pull_request",
      entityKey: `${repoFullName}#${number}`,
      state: pullRequestStateFromPayload(pr, action),
    };
  }
  if (eventType === "issues" || eventType === "issue_comment") {
    const issue = isRecord(payload.issue) ? payload.issue : null;
    const number = readNumber(issue?.number);
    if (!issue || number === null) return null;
    if (isRecord(issue.pull_request)) {
      return {
        entityType: "pull_request",
        entityKey: `${repoFullName}#${number}`,
        state: pullRequestStateFromIssuePayload(issue, action),
      };
    }
    return { entityType: "issue", entityKey: `${repoFullName}#${number}`, state: issueStateFromPayload(issue, action) };
  }
  return null;
}

function resolveEntityStateUpdate(
  eventType: string,
  action: string,
  payload: Record<string, unknown>,
  repoFullName: string,
): EntityStateSeed | null {
  if (eventType === "pull_request") {
    const pr = isRecord(payload.pull_request) ? payload.pull_request : null;
    const number = readNumber(pr?.number);
    if (!pr || number === null) return null;
    if (action === "closed" || action === "reopened") {
      return {
        entityType: "pull_request",
        entityKey: `${repoFullName}#${number}`,
        state: pullRequestStateFromPayload(pr, action),
      };
    }
    if (action === "converted_to_draft") {
      return { entityType: "pull_request", entityKey: `${repoFullName}#${number}`, state: "draft" };
    }
    if (action === "ready_for_review") {
      return { entityType: "pull_request", entityKey: `${repoFullName}#${number}`, state: "open" };
    }
    return null;
  }
  if (eventType === "issues") {
    const issue = isRecord(payload.issue) ? payload.issue : null;
    const number = readNumber(issue?.number);
    if (!issue || number === null || (action !== "closed" && action !== "reopened")) return null;
    return { entityType: "issue", entityKey: `${repoFullName}#${number}`, state: issueStateFromPayload(issue, action) };
  }
  return null;
}

export type NormalizedGithubWebhook = ScmNormalizedWebhook & {
  entityStateSeed: EntityStateSeed | null;
};

/** Pure GitHub adapter output: lifecycle observation and semantic event are independent. */
export function normalizeGithubWebhook(
  eventType: string,
  payload: unknown,
  ingress: ScmIngressContext,
): NormalizedGithubWebhook {
  const event = normalizeGithubEvent(eventType, payload, ingress);
  if (!isRecord(payload)) return { ingress, observation: null, event, entityStateSeed: null };
  const repo = isRecord(payload.repository) ? payload.repository : null;
  const repoFullName = readString(repo?.full_name);
  const action = readString(payload.action);
  if (!repoFullName || !action) return { ingress, observation: null, event, entityStateSeed: null };

  const entityStateSeed = resolveEntityStateSeed(eventType, action, payload, repoFullName);
  const stateUpdate = resolveEntityStateUpdate(eventType, action, payload, repoFullName);
  const entity = extractEventEntity(eventType, payload);
  const observation: ScmEntityObservation | null = entity
    ? {
        entity: {
          type: entity.type,
          projectKey: repoFullName,
          key: entity.key,
          ...(entity.title ? { title: entity.title } : {}),
          ...(entity.url ? { url: entity.url } : {}),
        },
        state: stateUpdate?.state ?? null,
        observedAt: new Date().toISOString(),
      }
    : null;
  return { ingress, observation, event, entityStateSeed };
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (isRecord(item)) {
      const login = readString(item.login);
      if (login) out.push(login.toLowerCase());
    }
  }
  return out;
}

type InvolveItem = { externalUsername: string; reason: InvolveReason };

function buildInvolves(items: ReadonlyArray<{ logins: string[]; reason: InvolveReason }>): InvolveItem[] {
  // First-occurrence wins per (lowercased) login. Callers should list
  // structural reasons (review_requested, assigned) before textual ones
  // (mentioned) so a participant cited via both routes keeps the more
  // specific reason in the audience card.
  const seen = new Set<string>();
  const out: InvolveItem[] = [];
  for (const group of items) {
    for (const login of group.logins) {
      const key = login.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ externalUsername: key, reason: group.reason });
    }
  }
  return out;
}

function entitySurfacePrefix(entity: GithubEntity): string {
  switch (entity.type) {
    case "pull_request":
      return "PR";
    case "issue":
      return "Issue";
    case "discussion":
      return "Discussion";
    case "commit":
      return "Commit";
  }
}

function entitySurfaceTitle(entity: GithubEntity, number: number | null): string {
  const prefix = entitySurfacePrefix(entity);
  const head = number !== null ? `${prefix} #${number}` : prefix;
  return entity.title ? `${head}: ${entity.title}` : head;
}

type RuleOutcome = {
  entity: GithubEntity;
  kind: NormalizedEventKind;
  involves: InvolveItem[];
  surface: { title: string; body: string; url: string };
  relatedRefs: { type: "issue"; key: string }[];
};

/**
 * Stage 1 — pure normalization. Returns the structured event for downstream
 * audience + delivery, or `null` for events we deliberately drop (silent /
 * out-of-scope event types and actions, malformed payloads, …).
 *
 * Pure function: no DB, no chat, no network. Caller is expected to hand the
 * raw payload, the wire event type from `x-github-event`, and the source +
 * deliveryId already resolved by the route handler.
 */
export function normalizeGithubEvent(
  eventType: string,
  payload: unknown,
  ingress: ScmIngressContext,
): NormalizedScmEvent | null {
  if (!isRecord(payload)) return null;

  const senderRec = isRecord(payload.sender) ? payload.sender : null;
  const senderLogin = readString(senderRec?.login);
  if (!senderLogin) return null;
  const senderIsBot = readString(senderRec?.type) === "Bot";

  const repoRec = isRecord(payload.repository) ? payload.repository : null;
  const repo = readString(repoRec?.full_name);
  if (!repo) return null;

  const action = readString(payload.action);
  const rule = buildRule(eventType, action, payload, repo);
  if (!rule) return null;

  return {
    ...ingress,
    eventType,
    action,
    entity: {
      type: rule.entity.type,
      projectKey: repo,
      key: rule.entity.key,
      title: rule.entity.title,
      url: rule.entity.url,
    },
    actor: { externalUsername: senderLogin, isBot: senderIsBot },
    kind: rule.kind,
    targets: rule.involves,
    surface: rule.surface,
    relatedRefs: rule.relatedRefs,
  };
}

function buildRule(
  eventType: string,
  action: string | null,
  payload: Record<string, unknown>,
  repo: string,
): RuleOutcome | null {
  switch (eventType) {
    case "pull_request":
      return buildPullRequestRule(action, payload, repo);
    case "pull_request_review":
      return buildPullRequestReviewRule(action, payload);
    case "pull_request_review_comment":
      return buildPullRequestReviewCommentRule(action, payload);
    case "issue_comment":
      return buildIssueCommentRule(action, payload);
    case "issues":
      return buildIssuesRule(action, payload);
    case "discussion":
      return buildDiscussionRule(action, payload);
    case "discussion_comment":
      return buildDiscussionCommentRule(action, payload);
    case "commit_comment":
      return buildCommitCommentRule(action, payload);
    default:
      return null;
  }
}

function buildPullRequestRule(
  action: string | null,
  payload: Record<string, unknown>,
  repo: string,
): RuleOutcome | null {
  const pr = isRecord(payload.pull_request) ? payload.pull_request : null;
  if (!pr) return null;
  const entity = extractEventEntity("pull_request", payload);
  if (!entity) return null;
  const number = readNumber(pr.number);
  const body = readString(pr.body) ?? "";
  const surface = {
    title: entitySurfaceTitle(entity, number),
    body,
    url: readString(pr.html_url) ?? "",
  };

  switch (action) {
    case "opened": {
      // Reviewer involvement is deliberately NOT collected here: GitHub also
      // fires a separate `review_requested` webhook per reviewer at PR
      // creation time, and that path handles reviewer notification. Doing
      // both produces duplicate cards for the same reviewer.
      const assigneeLogins = readStringArray(pr.assignees);
      const mentionLogins = extractMentions(body);
      return {
        entity,
        kind: "opened",
        involves: buildInvolves([
          { logins: assigneeLogins, reason: "assigned" },
          { logins: mentionLogins, reason: "mentioned" },
        ]),
        surface,
        relatedRefs: parseSameProjectClosingIssueRefs(body, repo),
      };
    }
    case "edited": {
      const mentionLogins = extractMentions(body);
      return {
        entity,
        kind: "edited",
        involves: buildInvolves([{ logins: mentionLogins, reason: "mentioned" }]),
        surface,
        relatedRefs: [],
      };
    }
    case "review_requested": {
      const reviewer = isRecord(payload.requested_reviewer) ? payload.requested_reviewer : null;
      const reviewerLogin = readString(reviewer?.login);
      // `requested_team` requests are deliberately skipped — team mentions
      // don't map to individual agents and would force `extractMentions`
      // semantics to diverge.
      const logins = reviewerLogin ? [reviewerLogin.toLowerCase()] : [];
      return {
        entity,
        kind: "review_requested",
        involves: buildInvolves([{ logins, reason: "review_requested" }]),
        surface,
        relatedRefs: [],
      };
    }
    case "ready_for_review": {
      // Draft → ready transition: fan out review_requested to every reviewer
      // currently on the PR. GitHub DOES emit `review_requested` when a
      // reviewer is added while the PR is still a draft, so a reviewer added
      // during the draft phase will receive both that card and this one —
      // accepted as a small-scale Bug-1 variant. Rationale: the draft-phase
      // card is typically treated as informational ("PR is being prepared"),
      // and the ready_for_review fan-out is the canonical actionable signal
      // that review can actually begin. The duplication is bounded to draft
      // PRs and not worth introducing per-(reviewer, PR) dedupe state to
      // eliminate.
      //
      // No reviewers on the PR → drop the event. Subscribed-only delivery
      // with empty involves is the exact "state-machine noise" pattern this
      // module avoids; if no one has been asked to review, there's nothing
      // actionable to announce.
      const reviewerLogins = readStringArray(pr.requested_reviewers);
      if (reviewerLogins.length === 0) return null;
      return {
        entity,
        kind: "review_requested",
        involves: buildInvolves([{ logins: reviewerLogins, reason: "review_requested" }]),
        surface,
        relatedRefs: [],
      };
    }
    case "assigned": {
      // Assignee added after PR creation. The `opened` payload already
      // carries any initial assignees, so this only fires for later changes.
      // Malformed payload with no assignee → drop, avoiding a content-less
      // card on the subscribed path.
      const assignee = isRecord(payload.assignee) ? payload.assignee : null;
      const assigneeLogin = readString(assignee?.login);
      if (!assigneeLogin) return null;
      const logins = [assigneeLogin.toLowerCase()];
      return {
        entity,
        kind: "assigned",
        involves: buildInvolves([{ logins, reason: "assigned" }]),
        surface,
        relatedRefs: [],
      };
    }
    case "synchronize":
      return {
        entity,
        kind: "synchronized",
        involves: [],
        surface,
        relatedRefs: [],
      };
    default:
      // Deliberately dropped (return null):
      //   - closed / reopened / converted_to_draft → PR state-machine
      //     transitions unrelated to code review. They would only fan out
      //     via the `subscribed` path, waking agents in already-bound chats
      //     with no actionable content.
      //   - labeled / unlabeled / milestoned / locked / auto_merge_* /
      //     review_request_removed / unassigned / enqueued / dequeued →
      //     metadata / merge-queue noise.
      return null;
  }
}

function buildPullRequestReviewRule(action: string | null, payload: Record<string, unknown>): RuleOutcome | null {
  if (action !== "submitted" && action !== "dismissed" && action !== "edited") return null;
  const pr = isRecord(payload.pull_request) ? payload.pull_request : null;
  const review = isRecord(payload.review) ? payload.review : null;
  if (!pr || !review) return null;
  const entity = extractEventEntity("pull_request_review", payload);
  if (!entity) return null;
  const number = readNumber(pr.number);
  const body = readString(review.body) ?? "";
  return {
    entity,
    kind: "reviewed",
    involves: buildInvolves([{ logins: extractMentions(body), reason: "mentioned" }]),
    surface: {
      title: entitySurfaceTitle(entity, number),
      body,
      url: readString(review.html_url) ?? "",
    },
    relatedRefs: [],
  };
}

function buildPullRequestReviewCommentRule(
  action: string | null,
  payload: Record<string, unknown>,
): RuleOutcome | null {
  if (action !== "created" && action !== "edited") return null;
  const pr = isRecord(payload.pull_request) ? payload.pull_request : null;
  const comment = isRecord(payload.comment) ? payload.comment : null;
  if (!pr || !comment) return null;
  const entity = extractEventEntity("pull_request_review_comment", payload);
  if (!entity) return null;
  const number = readNumber(pr.number);
  const body = readString(comment.body) ?? "";
  return {
    entity,
    kind: "review_comment",
    involves: buildInvolves([{ logins: extractMentions(body), reason: "mentioned" }]),
    surface: {
      title: entitySurfaceTitle(entity, number),
      body,
      url: readString(comment.html_url) ?? "",
    },
    relatedRefs: [],
  };
}

function buildIssueCommentRule(action: string | null, payload: Record<string, unknown>): RuleOutcome | null {
  if (action !== "created" && action !== "edited") return null;
  const issue = isRecord(payload.issue) ? payload.issue : null;
  const comment = isRecord(payload.comment) ? payload.comment : null;
  if (!issue || !comment) return null;
  // `extractEventEntity` handles the Bug 3 split: when `issue.pull_request`
  // is set, the entity comes out as a `pull_request`, not an `issue`. The
  // surface title is keyed off the resolved entity, so a PR comment
  // renders as "PR #N: ..." even though the wire eventType is
  // `issue_comment`.
  const entity = extractEventEntity("issue_comment", payload);
  if (!entity) return null;
  const number = readNumber(issue.number);
  const body = readString(comment.body) ?? "";
  return {
    entity,
    kind: "commented",
    involves: buildInvolves([{ logins: extractMentions(body), reason: "mentioned" }]),
    surface: {
      title: entitySurfaceTitle(entity, number),
      body,
      url: readString(comment.html_url) ?? "",
    },
    relatedRefs: [],
  };
}

function buildIssuesRule(action: string | null, payload: Record<string, unknown>): RuleOutcome | null {
  const issue = isRecord(payload.issue) ? payload.issue : null;
  if (!issue) return null;
  const entity = extractEventEntity("issues", payload);
  if (!entity) return null;
  const number = readNumber(issue.number);
  const body = readString(issue.body) ?? "";
  const url = readString(issue.html_url) ?? "";
  const title = entitySurfaceTitle(entity, number);

  switch (action) {
    case "opened": {
      const assigneeLogins = readStringArray(issue.assignees);
      const mentionLogins = extractMentions(body);
      return {
        entity,
        kind: "opened",
        involves: buildInvolves([
          { logins: assigneeLogins, reason: "assigned" },
          { logins: mentionLogins, reason: "mentioned" },
        ]),
        surface: { title, body, url },
        relatedRefs: [],
      };
    }
    case "edited": {
      const mentionLogins = extractMentions(body);
      return {
        entity,
        kind: "edited",
        involves: buildInvolves([{ logins: mentionLogins, reason: "mentioned" }]),
        surface: { title, body, url },
        relatedRefs: [],
      };
    }
    case "assigned": {
      // Mirrors `buildPullRequestRule.assigned`: drop content-less payloads
      // and use the dedicated `assigned` kind for clean downstream rendering.
      const assignee = isRecord(payload.assignee) ? payload.assignee : null;
      const login = readString(assignee?.login);
      if (!login) return null;
      const logins = [login.toLowerCase()];
      return {
        entity,
        kind: "assigned",
        involves: buildInvolves([{ logins, reason: "assigned" }]),
        surface: { title, body, url },
        relatedRefs: [],
      };
    }
    // Unlike `buildPullRequestRule`, issue `closed` and `reopened` are kept
    // — closing an issue typically signals the underlying problem is resolved
    // (or re-surfaces), which is actionable context for any subscribed
    // workflow agent. PR `closed`/`reopened`/`merged` are dropped because
    // they're pure state-machine transitions on code-review artifacts and
    // generate noise for already-subscribed chats. Asymmetry is intentional.
    case "closed":
      return {
        entity,
        kind: "closed",
        involves: [],
        surface: { title, body, url },
        relatedRefs: [],
      };
    case "reopened":
      return {
        entity,
        kind: "reopened",
        involves: [],
        surface: { title, body, url },
        relatedRefs: [],
      };
    default:
      // labeled / unlabeled / milestoned / demilestoned / pinned / unpinned / unassigned
      return null;
  }
}

function buildDiscussionRule(action: string | null, payload: Record<string, unknown>): RuleOutcome | null {
  const disc = isRecord(payload.discussion) ? payload.discussion : null;
  if (!disc) return null;
  const entity = extractEventEntity("discussion", payload);
  if (!entity) return null;
  const number = readNumber(disc.number);
  const body = readString(disc.body) ?? "";
  const url = readString(disc.html_url) ?? "";
  const title = entitySurfaceTitle(entity, number);

  switch (action) {
    case "created":
      return {
        entity,
        kind: "opened",
        involves: buildInvolves([{ logins: extractMentions(body), reason: "mentioned" }]),
        surface: { title, body, url },
        relatedRefs: [],
      };
    case "edited":
      return {
        entity,
        kind: "edited",
        involves: buildInvolves([{ logins: extractMentions(body), reason: "mentioned" }]),
        surface: { title, body, url },
        relatedRefs: [],
      };
    case "closed":
      return {
        entity,
        kind: "closed",
        involves: [],
        surface: { title, body, url },
        relatedRefs: [],
      };
    case "reopened":
      return {
        entity,
        kind: "reopened",
        involves: [],
        surface: { title, body, url },
        relatedRefs: [],
      };
    case "answered":
    case "unanswered":
      return {
        entity,
        kind: "other",
        involves: [],
        surface: { title, body, url },
        relatedRefs: [],
      };
    default:
      return null;
  }
}

function buildDiscussionCommentRule(action: string | null, payload: Record<string, unknown>): RuleOutcome | null {
  if (action !== "created" && action !== "edited") return null;
  const disc = isRecord(payload.discussion) ? payload.discussion : null;
  const comment = isRecord(payload.comment) ? payload.comment : null;
  if (!disc || !comment) return null;
  const entity = extractEventEntity("discussion_comment", payload);
  if (!entity) return null;
  const number = readNumber(disc.number);
  const body = readString(comment.body) ?? "";
  return {
    entity,
    kind: "commented",
    involves: buildInvolves([{ logins: extractMentions(body), reason: "mentioned" }]),
    surface: {
      title: entitySurfaceTitle(entity, number),
      body,
      url: readString(comment.html_url) ?? "",
    },
    relatedRefs: [],
  };
}

function buildCommitCommentRule(action: string | null, payload: Record<string, unknown>): RuleOutcome | null {
  if (action !== "created") return null;
  const comment = isRecord(payload.comment) ? payload.comment : null;
  if (!comment) return null;
  const entity = extractEventEntity("commit_comment", payload);
  if (!entity) return null;
  const body = readString(comment.body) ?? "";
  return {
    entity,
    kind: "commit_commented",
    involves: buildInvolves([{ logins: extractMentions(body), reason: "mentioned" }]),
    surface: {
      title: entitySurfaceTitle(entity, null),
      body,
      url: readString(comment.html_url) ?? "",
    },
    relatedRefs: [],
  };
}
