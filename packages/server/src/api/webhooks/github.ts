import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Database } from "../../db/connection.js";
import { agents } from "../../db/schema/agents.js";
import { BadRequestError, ConflictError, UnauthorizedError } from "../../errors.js";
import { createAgent } from "../../services/agent.js";
import { sendToAgent } from "../../services/message.js";
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
  const [existing] = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, GITHUB_ADAPTER_ID)).limit(1);

  if (existing) {
    return existing.id;
  }

  try {
    const agent = await createAgent(db, {
      id: GITHUB_ADAPTER_ID,
      type: "autonomous_agent",
      displayName: "GitHub Adapter",
      metadata: { source: "github", managed: true },
    });
    return agent.id;
  } catch (err) {
    if (err instanceof ConflictError) {
      // Another concurrent request created it first
      const [created] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, GITHUB_ADAPTER_ID))
        .limit(1);
      if (created) return created.id;
    }
    throw err;
  }
}

async function findTargetAgent(db: Database, repoFullName: string): Promise<string | null> {
  // First: look for an agent whose metadata has github.repos containing the repo full_name
  const allAgents = await db
    .select({ id: agents.id, metadata: agents.metadata, type: agents.type })
    .from(agents)
    .where(eq(agents.status, "active"));

  for (const agent of allAgents) {
    if (agent.id === GITHUB_ADAPTER_ID) continue;
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

  if (!process.env.AGENT_HUB_GITHUB_WEBHOOK_SECRET) {
    app.log.warn("GITHUB_WEBHOOK_SECRET is not set — webhook signature verification is disabled");
  }

  app.post("/github", async (request, reply) => {
    const rawBody = request.body;
    if (!Buffer.isBuffer(rawBody)) {
      throw new BadRequestError("Expected raw body buffer");
    }

    // Verify signature if secret is configured
    const secret = process.env.AGENT_HUB_GITHUB_WEBHOOK_SECRET;
    if (secret) {
      const signatureHeader = request.headers["x-hub-signature-256"];
      if (typeof signatureHeader !== "string") {
        throw new UnauthorizedError("Missing x-hub-signature-256 header");
      }
      verifySignature(secret, rawBody, signatureHeader);
    }

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

    if (eventType === "issues") {
      return handleIssuesEvent(app, payload, reply);
    }

    if (eventType === "issue_comment") {
      return handleIssueCommentEvent(app, payload, reply);
    }

    // Unhandled event type — acknowledge but do nothing
    return reply.status(200).send({ ok: true, event: eventType, handled: false });
  });
}

async function handleIssuesEvent(app: FastifyInstance, payload: unknown, reply: FastifyReply): Promise<unknown> {
  const data = parseIssuesPayload(payload);

  // Only handle specific actions
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

  const { message: msg, recipients } = await sendToAgent(app.db, senderId, targetAgentId, {
    format: "card",
    content,
    metadata,
  });

  notifyRecipients(app.notifier, recipients, msg.id);

  return reply.status(200).send({ ok: true, event: "issues", action: data.action, routed: true });
}

async function handleIssueCommentEvent(app: FastifyInstance, payload: unknown, reply: FastifyReply): Promise<unknown> {
  const data = parseIssueCommentPayload(payload);

  // Only handle "created" action
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

  const { message: msg, recipients } = await sendToAgent(app.db, senderId, targetAgentId, {
    format: "card",
    content,
    metadata,
  });

  notifyRecipients(app.notifier, recipients, msg.id);

  return reply.status(200).send({ ok: true, event: "issue_comment", action: data.action, routed: true });
}
