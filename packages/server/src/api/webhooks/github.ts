import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Database } from "../../db/connection.js";
import { agents } from "../../db/schema/agents.js";
import { BadRequestError, ConflictError, UnauthorizedError } from "../../errors.js";
import { createLogger } from "../../observability/index.js";
import { createAgent } from "../../services/agent.js";
import { findOrCreateDirectChat } from "../../services/chat.js";
import { sendMessage } from "../../services/message.js";
import { notifyRecipients } from "../../services/notifier.js";

const log = createLogger("GithubWebhook");

// ── GitHub payload types ────────────────────────────────────────────

type GitHubIssue = {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: Array<{ name: string }>;
  state: string;
};

type GitHubComment = {
  body: string;
  html_url: string;
  user: { login: string };
};

type GitHubRepository = {
  full_name: string;
};

type GitHubSender = {
  login: string;
};

type GitHubIssuesPayload = {
  action: string;
  issue: GitHubIssue;
  repository: GitHubRepository;
  sender: GitHubSender;
};

type GitHubIssueCommentPayload = {
  action: string;
  issue: GitHubIssue;
  comment: GitHubComment;
  repository: GitHubRepository;
  sender: GitHubSender;
};

// ── Helpers ─────────────────────────────────────────────────────────

const GITHUB_ADAPTER_ID = "github-adapter";

/** Exported so the App webhook endpoint can reuse the exact same HMAC check. */
export function verifyGithubWebhookSignature(secret: string, rawBody: Buffer, signatureHeader: string): void {
  verifySignature(secret, rawBody, signatureHeader);
}

function verifySignature(secret: string, rawBody: Buffer, signatureHeader: string): void {
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const expectedBuf = Buffer.from(expected, "utf8");
  const receivedBuf = Buffer.from(signatureHeader, "utf8");

  if (expectedBuf.length !== receivedBuf.length || !timingSafeEqual(expectedBuf, receivedBuf)) {
    throw new UnauthorizedError("Invalid webhook signature");
  }
}

async function ensureGitHubAdapterAgent(db: Database, organizationId: string): Promise<string> {
  const [existing] = await db
    .select({ uuid: agents.uuid })
    .from(agents)
    .where(and(eq(agents.organizationId, organizationId), eq(agents.name, GITHUB_ADAPTER_ID)))
    .limit(1);

  if (existing) {
    return existing.uuid;
  }

  try {
    const agent = await createAgent(db, {
      name: GITHUB_ADAPTER_ID,
      type: "autonomous_agent",
      displayName: "GitHub Adapter",
      organizationId,
      metadata: { source: "github", managed: true },
    });
    return agent.uuid;
  } catch (err) {
    if (err instanceof ConflictError) {
      // Another concurrent request created it first
      const [created] = await db
        .select({ uuid: agents.uuid })
        .from(agents)
        .where(and(eq(agents.organizationId, organizationId), eq(agents.name, GITHUB_ADAPTER_ID)))
        .limit(1);
      if (created) return created.uuid;
    }
    throw err;
  }
}

async function findTargetAgent(db: Database, organizationId: string, repoFullName: string): Promise<string | null> {
  // First: look for an agent whose metadata has github.repos containing the repo full_name
  const allAgents = await db
    .select({ id: agents.uuid, name: agents.name, metadata: agents.metadata, type: agents.type })
    .from(agents)
    .where(and(eq(agents.organizationId, organizationId), eq(agents.status, "active")));

  for (const agent of allAgents) {
    if (agent.name === GITHUB_ADAPTER_ID) continue;
    const meta = agent.metadata;
    if (meta && typeof meta === "object" && "github" in meta) {
      const github = meta.github;
      if (isRecord(github) && "repos" in github) {
        const repos = github.repos;
        if (Array.isArray(repos) && repos.includes(repoFullName)) {
          return agent.id;
        }
      }
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract unique @mentions from text. Returns lowercase usernames.
 * Excludes email patterns (user@example.com) and team mentions (@org/team). */
export function extractMentions(text: string | null | undefined): string[] {
  if (!text) return [];
  // Negative lookbehind: @ must not be preceded by a word char (excludes emails)
  // Capture optional trailing / to detect team mentions (@org/team) and skip them
  const re = /(?<!\w)@([a-zA-Z0-9][\w-]*)(\/)?/g;
  const names = new Set<string>();
  for (const m of text.matchAll(re)) {
    if (m[2]) continue; // Skip team mentions like @org/team
    names.add((m[1] as string).toLowerCase());
  }
  return [...names];
}

/** Extract mentions from structural payload fields (not free-form text).
 * GitHub's `pull_request.review_requested` puts the targeted reviewer in
 * `requested_reviewer.login`, not in any text body — `extractMentions` would
 * miss it. Team requests use `requested_team` instead, which we deliberately
 * skip to stay consistent with `extractMentions` ignoring `@org/team`. */
export function extractStructuralMentions(eventType: string, payload: unknown): string[] {
  if (!isRecord(payload)) return [];
  if (eventType !== "pull_request") return [];
  if (payload.action !== "review_requested") return [];
  const reviewer = isRecord(payload.requested_reviewer) ? payload.requested_reviewer : null;
  const login = typeof reviewer?.login === "string" ? reviewer.login : null;
  return login ? [login.toLowerCase()] : [];
}

/** Verdict on whether a delegate_mention target is eligible to receive a fan-out.
 * Split from `routeMentionDelegations` so the rejection logic is unit-testable
 * without mocking the fastify app / DB / chat service. */
export type DelegateTargetVerdict = "ok" | "not_found" | "cross_org" | "inactive";

const DELEGATE_VERDICT_MESSAGES: Record<DelegateTargetVerdict, string> = {
  ok: "delegate_mention target eligible",
  not_found: "delegate_mention target not found, skipping",
  cross_org: "delegate_mention target belongs to another org, skipping",
  inactive: "delegate_mention target not active, skipping",
};

export function evaluateDelegateTarget(
  target: { organizationId: string; status: string } | undefined,
  sourceOrgId: string,
): DelegateTargetVerdict {
  if (!target) return "not_found";
  if (target.organizationId !== sourceOrgId) return "cross_org";
  if (target.status !== "active") return "inactive";
  return "ok";
}

type MentionContext = {
  event: string;
  action?: string;
  repository: string;
  sender: string;
  title: string;
  body: string;
  url: string;
};

/**
 * Route @mentions to delegate agents.
 * For each mentioned user who has delegate_mention configured,
 * send a card message from the mentioned user to their delegate.
 */
async function routeMentionDelegations(
  app: FastifyInstance,
  organizationId: string,
  mentionedNames: string[],
  ctx: MentionContext,
): Promise<number> {
  if (mentionedNames.length === 0) return 0;

  // Batch lookup: find agents with delegate_mention set (match by name)
  const delegates = await app.db
    .select({
      id: agents.uuid,
      name: agents.name,
      delegateMention: agents.delegateMention,
      status: agents.status,
    })
    .from(agents)
    .where(
      and(
        eq(agents.organizationId, organizationId),
        inArray(agents.name, mentionedNames),
        isNotNull(agents.delegateMention),
      ),
    );

  let routed = 0;
  for (const agent of delegates) {
    if (agent.status !== "active" || !agent.delegateMention) continue;

    // Verify delegate target exists, is active, and belongs to the same org.
    // Cross-org checks are split out so the log distinguishes "target gone"
    // from "target misconfigured". `findOrCreateDirectChat` would also reject
    // a cross-org pair (commit 6a68a6d / #292) but only as a generic
    // BadRequestError swallowed by the catch below — the explicit check here
    // surfaces a misconfiguration warning ops can act on.
    const [target] = await app.db
      .select({ id: agents.uuid, status: agents.status, organizationId: agents.organizationId })
      .from(agents)
      .where(eq(agents.uuid, agent.delegateMention))
      .limit(1);

    const verdict = evaluateDelegateTarget(target, organizationId);
    if (verdict !== "ok") {
      log.warn(
        {
          targetAgent: agent.delegateMention,
          sourceAgent: agent.name,
          sourceOrg: organizationId,
          targetOrg: target?.organizationId,
          targetStatus: target?.status,
          verdict,
        },
        DELEGATE_VERDICT_MESSAGES[verdict],
      );
      continue;
    }

    try {
      const chat = await findOrCreateDirectChat(app.db, agent.id, agent.delegateMention);
      const { message: msg, recipients } = await sendMessage(app.db, chat.id, agent.id, {
        format: "card",
        content: {
          type: "github_mention",
          mentionedUser: agent.name,
          event: ctx.event,
          action: ctx.action,
          repository: ctx.repository,
          sender: ctx.sender,
          title: ctx.title,
          body: ctx.body,
          url: ctx.url,
        },
        metadata: {
          source: "github",
          event: "mention_delegation",
          mentionedUser: agent.name,
          action: ctx.action,
        },
      });
      notifyRecipients(app.notifier, recipients, msg.id);
      routed++;
    } catch (err) {
      log.error(
        { err, sourceAgent: agent.name, targetAgent: agent.delegateMention },
        "failed to route mention delegation",
      );
    }
  }

  return routed;
}

function parseIssuesPayload(body: unknown): GitHubIssuesPayload {
  if (!isRecord(body)) throw new BadRequestError("Invalid payload: expected object");
  if (typeof body.action !== "string") throw new BadRequestError("Invalid payload: missing action");
  if (!isRecord(body.issue)) throw new BadRequestError("Invalid payload: missing issue");
  if (!isRecord(body.repository)) throw new BadRequestError("Invalid payload: missing repository");
  if (!isRecord(body.sender)) throw new BadRequestError("Invalid payload: missing sender");

  const issue = body.issue;
  const labels = Array.isArray(issue.labels)
    ? issue.labels.filter((l): l is { name: string } => isRecord(l) && typeof l.name === "string")
    : [];

  return {
    action: body.action,
    issue: {
      number: typeof issue.number === "number" ? issue.number : 0,
      title: typeof issue.title === "string" ? issue.title : "",
      body: typeof issue.body === "string" ? issue.body : null,
      html_url: typeof issue.html_url === "string" ? issue.html_url : "",
      labels,
      state: typeof issue.state === "string" ? issue.state : "open",
    },
    repository: {
      full_name: typeof body.repository.full_name === "string" ? body.repository.full_name : "",
    },
    sender: {
      login: typeof body.sender.login === "string" ? body.sender.login : "",
    },
  };
}

function parseIssueCommentPayload(body: unknown): GitHubIssueCommentPayload {
  const base = parseIssuesPayload(body);
  if (!isRecord(body)) throw new BadRequestError("Invalid payload: expected object");
  if (!isRecord(body.comment)) throw new BadRequestError("Invalid payload: missing comment");

  const comment = body.comment;
  const commentUser = isRecord(comment.user) ? comment.user : { login: "" };

  return {
    ...base,
    comment: {
      body: typeof comment.body === "string" ? comment.body : "",
      html_url: typeof comment.html_url === "string" ? comment.html_url : "",
      user: {
        login: typeof commentUser.login === "string" ? commentUser.login : "",
      },
    },
  };
}

// Legacy per-org webhook route (`POST /webhooks/github/:orgId`) and the
// `getDecryptedGithubWebhookSecret` lookup were removed in the D3 cutover.
// What remains in this file are the dispatch helpers that the App-flow
// webhook endpoint (`webhooks/github-app.ts`) imports — same downstream
// pipeline, different ingress.

/** Extract text body from any GitHub webhook event for @mention scanning. */
function extractEventText(eventType: string, payload: unknown): string | null {
  if (!isRecord(payload)) return null;

  switch (eventType) {
    case "issues": {
      const issue = isRecord(payload.issue) ? payload.issue : null;
      return typeof issue?.body === "string" ? issue.body : null;
    }
    case "issue_comment":
    case "pull_request_review_comment":
    case "commit_comment":
    case "discussion_comment": {
      const comment = isRecord(payload.comment) ? payload.comment : null;
      return typeof comment?.body === "string" ? comment.body : null;
    }
    case "pull_request": {
      const pr = isRecord(payload.pull_request) ? payload.pull_request : null;
      return typeof pr?.body === "string" ? pr.body : null;
    }
    case "pull_request_review": {
      const review = isRecord(payload.review) ? payload.review : null;
      return typeof review?.body === "string" ? review.body : null;
    }
    case "discussion": {
      const disc = isRecord(payload.discussion) ? payload.discussion : null;
      return typeof disc?.body === "string" ? disc.body : null;
    }
    default:
      return null;
  }
}

/** Extract context info from any GitHub webhook event for delegation messages. */
function extractEventContext(eventType: string, payload: unknown): MentionContext | null {
  if (!isRecord(payload)) return null;

  const repo = isRecord(payload.repository) ? payload.repository : null;
  const sender = isRecord(payload.sender) ? payload.sender : null;
  const repository = typeof repo?.full_name === "string" ? repo.full_name : "";
  const senderLogin = typeof sender?.login === "string" ? sender.login : "";
  const action = typeof payload.action === "string" ? payload.action : undefined;

  switch (eventType) {
    case "issues": {
      const issue = isRecord(payload.issue) ? payload.issue : null;
      if (!issue) return null;
      return {
        event: "issues",
        action,
        repository,
        sender: senderLogin,
        title: `Issue #${issue.number}: ${issue.title}`,
        body: typeof issue.body === "string" ? issue.body : "",
        url: typeof issue.html_url === "string" ? issue.html_url : "",
      };
    }
    case "issue_comment": {
      const issue = isRecord(payload.issue) ? payload.issue : null;
      const comment = isRecord(payload.comment) ? payload.comment : null;
      if (!issue || !comment) return null;
      return {
        event: "issue_comment",
        action,
        repository,
        sender: senderLogin,
        title: `Issue #${issue.number}: ${issue.title}`,
        body: typeof comment.body === "string" ? comment.body : "",
        url: typeof comment.html_url === "string" ? comment.html_url : "",
      };
    }
    case "pull_request": {
      const pr = isRecord(payload.pull_request) ? payload.pull_request : null;
      if (!pr) return null;
      return {
        event: "pull_request",
        action,
        repository,
        sender: senderLogin,
        title: `PR #${pr.number}: ${pr.title}`,
        body: typeof pr.body === "string" ? pr.body : "",
        url: typeof pr.html_url === "string" ? pr.html_url : "",
      };
    }
    case "pull_request_review": {
      const pr = isRecord(payload.pull_request) ? payload.pull_request : null;
      const review = isRecord(payload.review) ? payload.review : null;
      if (!pr || !review) return null;
      return {
        event: "pull_request_review",
        action,
        repository,
        sender: senderLogin,
        title: `PR #${pr.number}: ${pr.title}`,
        body: typeof review.body === "string" ? review.body : "",
        url: typeof review.html_url === "string" ? review.html_url : "",
      };
    }
    case "pull_request_review_comment": {
      const pr = isRecord(payload.pull_request) ? payload.pull_request : null;
      const comment = isRecord(payload.comment) ? payload.comment : null;
      if (!pr || !comment) return null;
      return {
        event: "pull_request_review_comment",
        action,
        repository,
        sender: senderLogin,
        title: `PR #${pr.number}: ${pr.title}`,
        body: typeof comment.body === "string" ? comment.body : "",
        url: typeof comment.html_url === "string" ? comment.html_url : "",
      };
    }
    case "discussion": {
      const disc = isRecord(payload.discussion) ? payload.discussion : null;
      if (!disc) return null;
      return {
        event: "discussion",
        action,
        repository,
        sender: senderLogin,
        title: typeof disc.title === "string" ? disc.title : "",
        body: typeof disc.body === "string" ? disc.body : "",
        url: typeof disc.html_url === "string" ? disc.html_url : "",
      };
    }
    case "discussion_comment": {
      const disc = isRecord(payload.discussion) ? payload.discussion : null;
      const comment = isRecord(payload.comment) ? payload.comment : null;
      if (!disc || !comment) return null;
      return {
        event: "discussion_comment",
        action,
        repository,
        sender: senderLogin,
        title: typeof disc.title === "string" ? disc.title : "",
        body: typeof comment.body === "string" ? comment.body : "",
        url: typeof comment.html_url === "string" ? comment.html_url : "",
      };
    }
    case "commit_comment": {
      const comment = isRecord(payload.comment) ? payload.comment : null;
      if (!comment) return null;
      return {
        event: "commit_comment",
        action,
        repository,
        sender: senderLogin,
        title: "Commit comment",
        body: typeof comment.body === "string" ? comment.body : "",
        url: typeof comment.html_url === "string" ? comment.html_url : "",
      };
    }
    default:
      return null;
  }
}

/**
 * Run mention delegation for a given event type and payload.
 * Only called after action gating confirms this is a "new content" event.
 */
/** See `handleIssuesEvent` for why this is exported. */
export async function handleMentionDelegation(
  app: FastifyInstance,
  organizationId: string,
  eventType: string,
  payload: unknown,
): Promise<number> {
  const mentionText = extractEventText(eventType, payload);
  const textMentions = extractMentions(mentionText);
  const structuralMentions = extractStructuralMentions(eventType, payload);
  const mentions = [...new Set([...textMentions, ...structuralMentions])];
  const mentionCtx = extractEventContext(eventType, payload);
  if (mentions.length > 0 && mentionCtx) {
    return routeMentionDelegations(app, organizationId, mentions, mentionCtx);
  }
  return 0;
}

/** Actions that represent new/changed content (worth scanning for @mentions).
 * Note: `pull_request.review_requested` doesn't carry an @mention in any
 * text body — the reviewer is in `requested_reviewer.login`. We pick it up
 * via `extractStructuralMentions`. The complementary `review_request_removed`
 * is intentionally omitted to avoid notifying the reviewer twice. */
export const MENTION_ACTIONS: Record<string, string[]> = {
  issues: ["opened", "edited"],
  issue_comment: ["created"],
  pull_request: ["opened", "edited", "review_requested"],
  pull_request_review: ["submitted"],
  pull_request_review_comment: ["created"],
  discussion: ["created", "edited"],
  discussion_comment: ["created"],
  commit_comment: ["created"],
};

// Exported so the GitHub App webhook endpoint (`webhooks/github-app.ts`)
// can reuse the same dispatch logic. D3 cutover (last commit in this PR)
// moves the helpers into a service module and deletes this file outright.
export async function handleIssuesEvent(
  app: FastifyInstance,
  organizationId: string,
  eventType: string,
  payload: unknown,
  reply: FastifyReply,
): Promise<unknown> {
  const data = parseIssuesPayload(payload);

  // Mention delegation — only on new/changed content
  if (MENTION_ACTIONS.issues?.includes(data.action)) {
    await handleMentionDelegation(app, organizationId, eventType, payload);
  }

  // Only handle specific actions for repo-targeted routing
  const handledActions = ["opened", "edited", "labeled"];
  if (!handledActions.includes(data.action)) {
    return reply.status(200).send({ ok: true, event: "issues", action: data.action, handled: false });
  }

  const [senderId, targetAgentId] = await Promise.all([
    ensureGitHubAdapterAgent(app.db, organizationId),
    findTargetAgent(app.db, organizationId, data.repository.full_name),
  ]);

  if (!targetAgentId) {
    log.warn({ repo: data.repository.full_name, event: "issue" }, "no target agent found for GitHub event");
    return reply.status(200).send({ ok: true, event: "issues", action: data.action, routed: false });
  }

  const content = {
    type: "github_issue",
    action: data.action,
    issue: {
      number: data.issue.number,
      title: data.issue.title,
      body: data.issue.body,
      url: data.issue.html_url,
      labels: data.issue.labels.map((l) => l.name),
      state: data.issue.state,
    },
    repository: data.repository.full_name,
    sender: data.sender.login,
  };

  const metadata = {
    source: "github",
    event: "issues",
    action: data.action,
  };

  const chat = await findOrCreateDirectChat(app.db, senderId, targetAgentId);
  const { message: msg, recipients } = await sendMessage(app.db, chat.id, senderId, {
    format: "card",
    content,
    metadata,
  });

  notifyRecipients(app.notifier, recipients, msg.id);

  return reply.status(200).send({ ok: true, event: "issues", action: data.action, routed: true });
}

/** See `handleIssuesEvent` for why this is exported. */
export async function handleIssueCommentEvent(
  app: FastifyInstance,
  organizationId: string,
  eventType: string,
  payload: unknown,
  reply: FastifyReply,
): Promise<unknown> {
  const data = parseIssueCommentPayload(payload);

  // Mention delegation — only on new comments
  if (MENTION_ACTIONS.issue_comment?.includes(data.action)) {
    await handleMentionDelegation(app, organizationId, eventType, payload);
  }

  // Only handle "created" action for repo-targeted routing
  if (data.action !== "created") {
    return reply.status(200).send({ ok: true, event: "issue_comment", action: data.action, handled: false });
  }

  const [senderId, targetAgentId] = await Promise.all([
    ensureGitHubAdapterAgent(app.db, organizationId),
    findTargetAgent(app.db, organizationId, data.repository.full_name),
  ]);

  if (!targetAgentId) {
    log.warn({ repo: data.repository.full_name, event: "issue_comment" }, "no target agent found for GitHub event");
    return reply.status(200).send({ ok: true, event: "issue_comment", action: data.action, routed: false });
  }

  const content = {
    type: "github_issue_comment",
    action: data.action,
    issue: {
      number: data.issue.number,
      title: data.issue.title,
      url: data.issue.html_url,
      labels: data.issue.labels.map((l) => l.name),
      state: data.issue.state,
    },
    comment: {
      body: data.comment.body,
      url: data.comment.html_url,
      author: data.comment.user.login,
    },
    repository: data.repository.full_name,
    sender: data.sender.login,
  };

  const metadata = {
    source: "github",
    event: "issue_comment",
    action: data.action,
  };

  const chat = await findOrCreateDirectChat(app.db, senderId, targetAgentId);
  const { message: msg, recipients } = await sendMessage(app.db, chat.id, senderId, {
    format: "card",
    content,
    metadata,
  });

  notifyRecipients(app.notifier, recipients, msg.id);

  return reply.status(200).send({ ok: true, event: "issue_comment", action: data.action, routed: true });
}
