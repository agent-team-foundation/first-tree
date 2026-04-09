import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Database } from "../../db/connection.js";
import { agents } from "../../db/schema/agents.js";
import { BadRequestError, ConflictError, UnauthorizedError } from "../../errors.js";
import { createAgent } from "../../services/agent.js";
import { findOrCreateDirectChat } from "../../services/chat.js";
import { sendMessage } from "../../services/message.js";
import { notifyRecipients } from "../../services/notifier.js";

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

function verifySignature(secret: string, rawBody: Buffer, signatureHeader: string): void {
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const expectedBuf = Buffer.from(expected, "utf8");
  const receivedBuf = Buffer.from(signatureHeader, "utf8");

  if (expectedBuf.length !== receivedBuf.length || !timingSafeEqual(expectedBuf, receivedBuf)) {
    throw new UnauthorizedError("Invalid webhook signature");
  }
}

async function ensureGitHubAdapterAgent(db: Database): Promise<string> {
  const [existing] = await db
    .select({ uuid: agents.uuid })
    .from(agents)
    .where(and(eq(agents.organizationId, "default"), eq(agents.name, GITHUB_ADAPTER_ID)))
    .limit(1);

  if (existing) {
    return existing.uuid;
  }

  try {
    const agent = await createAgent(db, {
      name: GITHUB_ADAPTER_ID,
      type: "autonomous_agent",
      displayName: "GitHub Adapter",
      metadata: { source: "github", managed: true },
    });
    return agent.uuid;
  } catch (err) {
    if (err instanceof ConflictError) {
      // Another concurrent request created it first
      const [created] = await db
        .select({ uuid: agents.uuid })
        .from(agents)
        .where(and(eq(agents.organizationId, "default"), eq(agents.name, GITHUB_ADAPTER_ID)))
        .limit(1);
      if (created) return created.uuid;
    }
    throw err;
  }
}

async function findTargetAgent(db: Database, repoFullName: string): Promise<string | null> {
  // First: look for an agent whose metadata has github.repos containing the repo full_name
  const allAgents = await db
    .select({ id: agents.uuid, name: agents.name, metadata: agents.metadata, type: agents.type })
    .from(agents)
    .where(eq(agents.status, "active"));

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

type MentionContext = {
  event: string;
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
    .where(and(inArray(agents.name, mentionedNames), isNotNull(agents.delegateMention)));

  let routed = 0;
  for (const agent of delegates) {
    if (agent.status !== "active" || !agent.delegateMention) continue;

    // Verify delegate target exists and is active (delegateMention stores a UUID)
    const [target] = await app.db
      .select({ id: agents.uuid, status: agents.status })
      .from(agents)
      .where(eq(agents.uuid, agent.delegateMention))
      .limit(1);

    if (!target || target.status !== "active") {
      app.log.warn(`delegate_mention target "${agent.delegateMention}" for "${agent.name}" is not active, skipping`);
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
        },
      });
      notifyRecipients(app.notifier, recipients, msg.id);
      routed++;
    } catch (err) {
      app.log.error(err, `Failed to route mention delegation from "${agent.name}" to "${agent.delegateMention}"`);
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

// ── Route ───────────────────────────────────────────────────────────

export async function githubWebhookRoutes(app: FastifyInstance): Promise<void> {
  // Scoped to this plugin only (/webhooks). If other webhook adapters (Slack, Feishu)
  // are added under the same prefix, they should be registered as separate sub-plugins
  // to avoid inheriting this raw-buffer parser.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  const webhookSecret = app.config.github.webhookSecret;
  const webhookMax = app.config.rateLimit?.webhookMax ?? 60;

  app.post(
    "/github",
    { config: { rateLimit: { max: webhookMax, timeWindow: "1 minute" } } },
    async (request, reply) => {
      // Webhook secret not configured — reject requests
      if (!webhookSecret) {
        return reply
          .status(501)
          .send({ error: "GitHub webhook is not configured. Set FIRST_TREE_HUB_GITHUB_WEBHOOK_SECRET to enable." });
      }

      const rawBody = request.body;
      if (!Buffer.isBuffer(rawBody)) {
        throw new BadRequestError("Expected raw body buffer");
      }

      // Verify webhook signature
      const signatureHeader = request.headers["x-hub-signature-256"];
      if (typeof signatureHeader !== "string") {
        throw new UnauthorizedError("Missing x-hub-signature-256 header");
      }
      verifySignature(webhookSecret, rawBody, signatureHeader);

      // Parse JSON from raw body
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        throw new BadRequestError("Invalid JSON payload");
      }

      const eventType = request.headers["x-github-event"];
      if (typeof eventType !== "string") {
        throw new BadRequestError("Missing x-github-event header");
      }

      // Handle ping event (GitHub sends this when webhook is first configured)
      if (eventType === "ping") {
        return reply.status(200).send({ ok: true, event: "ping" });
      }

      // --- Event-specific handlers (mention delegation runs inside, after action gating) ---
      if (eventType === "issues") {
        return handleIssuesEvent(app, eventType, payload, reply);
      }

      if (eventType === "issue_comment") {
        return handleIssueCommentEvent(app, eventType, payload, reply);
      }

      // Other event types with @mention support (PRs, discussions, reviews, etc.)
      // Only run delegation if the action represents new/changed content
      let mentionsRouted = 0;
      const allowedActions = MENTION_ACTIONS[eventType];
      const action = isRecord(payload) && typeof payload.action === "string" ? payload.action : undefined;
      if (allowedActions && action && allowedActions.includes(action)) {
        mentionsRouted = await handleMentionDelegation(app, eventType, payload);
      }
      return reply.status(200).send({ ok: true, event: eventType, handled: mentionsRouted > 0, mentionsRouted });
    },
  );
}

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

  switch (eventType) {
    case "issues": {
      const issue = isRecord(payload.issue) ? payload.issue : null;
      if (!issue) return null;
      return {
        event: "issues",
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
async function handleMentionDelegation(app: FastifyInstance, eventType: string, payload: unknown): Promise<number> {
  const mentionText = extractEventText(eventType, payload);
  const mentions = extractMentions(mentionText);
  const mentionCtx = extractEventContext(eventType, payload);
  if (mentions.length > 0 && mentionCtx) {
    return routeMentionDelegations(app, mentions, mentionCtx);
  }
  return 0;
}

/** Actions that represent new/changed content (worth scanning for @mentions). */
const MENTION_ACTIONS: Record<string, string[]> = {
  issues: ["opened", "edited"],
  issue_comment: ["created"],
  pull_request: ["opened", "edited"],
  pull_request_review: ["submitted"],
  pull_request_review_comment: ["created"],
  discussion: ["created", "edited"],
  discussion_comment: ["created"],
  commit_comment: ["created"],
};

async function handleIssuesEvent(
  app: FastifyInstance,
  eventType: string,
  payload: unknown,
  reply: FastifyReply,
): Promise<unknown> {
  const data = parseIssuesPayload(payload);

  // Mention delegation — only on new/changed content
  if (MENTION_ACTIONS.issues?.includes(data.action)) {
    await handleMentionDelegation(app, eventType, payload);
  }

  // Only handle specific actions for repo-targeted routing
  const handledActions = ["opened", "edited", "labeled"];
  if (!handledActions.includes(data.action)) {
    return reply.status(200).send({ ok: true, event: "issues", action: data.action, handled: false });
  }

  const [senderId, targetAgentId] = await Promise.all([
    ensureGitHubAdapterAgent(app.db),
    findTargetAgent(app.db, data.repository.full_name),
  ]);

  if (!targetAgentId) {
    app.log.warn(`No target agent found for GitHub issue event on ${data.repository.full_name}`);
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

async function handleIssueCommentEvent(
  app: FastifyInstance,
  eventType: string,
  payload: unknown,
  reply: FastifyReply,
): Promise<unknown> {
  const data = parseIssueCommentPayload(payload);

  // Mention delegation — only on new comments
  if (MENTION_ACTIONS.issue_comment?.includes(data.action)) {
    await handleMentionDelegation(app, eventType, payload);
  }

  // Only handle "created" action for repo-targeted routing
  if (data.action !== "created") {
    return reply.status(200).send({ ok: true, event: "issue_comment", action: data.action, handled: false });
  }

  const [senderId, targetAgentId] = await Promise.all([
    ensureGitHubAdapterAgent(app.db),
    findTargetAgent(app.db, data.repository.full_name),
  ]);

  if (!targetAgentId) {
    app.log.warn(`No target agent found for GitHub issue_comment event on ${data.repository.full_name}`);
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
