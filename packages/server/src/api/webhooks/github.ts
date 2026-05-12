import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { agents } from "../../db/schema/agents.js";
import { BadRequestError, UnauthorizedError } from "../../errors.js";
import { createLogger } from "../../observability/index.js";
import { claimEvent, unclaimEvent } from "../../services/adapter-mapping.js";
import { resolveTargetChat } from "../../services/github-entity-chat.js";
import { sendMessage } from "../../services/message.js";
import { notifyRecipients } from "../../services/notifier.js";
import { getDecryptedGithubWebhookSecret } from "../../services/org-settings.js";
import { extractEventEntity, type GithubEntity, isRecord, parseFixesRefs, shouldSilent } from "./github-entity.js";

const log = createLogger("GithubWebhook");

// ── Helpers ─────────────────────────────────────────────────────────

function verifySignature(secret: string, rawBody: Buffer, signatureHeader: string): void {
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const expectedBuf = Buffer.from(expected, "utf8");
  const receivedBuf = Buffer.from(signatureHeader, "utf8");

  if (expectedBuf.length !== receivedBuf.length || !timingSafeEqual(expectedBuf, receivedBuf)) {
    throw new UnauthorizedError("Invalid webhook signature");
  }
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
 *
 * For each mentioned GitHub user who maps to an agent with `delegate_mention`
 * configured, resolve which chat the event belongs to (via §4.4's
 * entity-clustering rules) and post a card from the human-bound agent to its
 * delegate.
 *
 * The entity argument is the §4.2 entity for the current event; `relatedRefs`
 * is the parsed `Fixes #N` list (empty for non-PR events). Both are
 * pre-computed by the caller so the heavy parsing doesn't run once per
 * mention.
 */
async function routeMentionDelegations(
  app: FastifyInstance,
  organizationId: string,
  mentionedNames: string[],
  ctx: MentionContext,
  entity: GithubEntity,
  relatedRefs: GithubEntity[],
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
    // from "target misconfigured". `createChat` (called by resolveTargetChat)
    // would also reject a cross-org pair via the same BadRequestError but
    // the explicit check here surfaces a misconfiguration warning ops can
    // act on.
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
      const resolved = await resolveTargetChat(app.db, {
        organizationId,
        humanAgentId: agent.id,
        delegateAgentId: agent.delegateMention,
        entity,
        relatedEntities: relatedRefs,
        eventType: ctx.event,
        // `ctx.action` is narrowed to a non-empty string upstream
        // (`MENTION_ACTIONS` gating in the webhook route), but the
        // `MentionContext` type keeps it optional. Fall back to "" for the
        // unreachable case so the prefix table just picks the entity-type
        // default.
        action: ctx.action ?? "",
      });
      log.info(
        {
          chatId: resolved.chatId,
          entityType: entity.type,
          entityKey: entity.key,
          boundVia: resolved.boundVia,
          created: resolved.created,
          humanAgent: agent.name,
        },
        "resolved entity chat",
      );
      const { message: msg, recipients } = await sendMessage(app.db, resolved.chatId, agent.id, {
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
          entity: { type: entity.type, key: entity.key, url: entity.url ?? null },
        },
        metadata: {
          source: "github",
          event: "mention_delegation",
          mentionedUser: agent.name,
          action: ctx.action,
          entityType: entity.type,
          entityKey: entity.key,
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

// ── Route ───────────────────────────────────────────────────────────

export async function githubWebhookRoutes(app: FastifyInstance): Promise<void> {
  // Scoped to this plugin only (/webhooks). If other webhook adapters (Slack, Feishu)
  // are added under the same prefix, they should be registered as separate sub-plugins
  // to avoid inheriting this raw-buffer parser.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  const webhookMax = app.config.rateLimit?.webhookMax ?? 60;

  app.post<{ Params: { orgId: string } }>(
    "/github/:orgId",
    { config: { rateLimit: { max: webhookMax, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { orgId } = request.params;

      // Resolve the per-org webhook secret. Missing org and "secret not
      // configured" both fall through to the same 501 — the orgId is in
      // the URL already and timing differentiation here wouldn't buy real
      // defense (UUID v7 is not enumerable). (#5)
      const webhookSecret = await getDecryptedGithubWebhookSecret(app.db, orgId, app.config.secrets.encryptionKey);
      if (!webhookSecret) {
        return reply.status(501).send({
          error:
            "GitHub webhook is not configured for this organization. An admin must set the webhook secret in Team settings.",
        });
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

      // Handle ping event (GitHub sends this when webhook is first configured).
      // Skipped from idempotency tracking: pings have no side effects and
      // shouldn't consume rows in `processed_events`.
      if (eventType === "ping") {
        return reply.status(200).send({ ok: true, event: "ping" });
      }

      // Static silent-events filter (§4.8). Runs BEFORE idempotency-claim
      // because silent events are net-zero side-effect — claiming them would
      // waste a row in `processed_events` for no benefit.
      if (shouldSilent(eventType, payload)) {
        return reply.status(200).send({ ok: true, event: eventType, silent: true });
      }

      // Idempotency: GitHub retries failed deliveries (and occasionally
      // double-fires near-simultaneous events) with the same
      // `x-github-delivery` UUID. Without this gate, retries produce
      // duplicate fan-out messages. See issue #283. Reuses the
      // `processed_events` table that the Feishu adapter already uses
      // via `claimEvent` / `unclaimEvent`.
      const deliveryHeader = request.headers["x-github-delivery"];
      const deliveryId = typeof deliveryHeader === "string" && deliveryHeader.length > 0 ? deliveryHeader : null;

      if (deliveryId) {
        const claimed = await claimEvent(app.db, deliveryId, "github");
        if (!claimed) {
          log.info({ deliveryId, eventType }, "duplicate GitHub delivery, skipping");
          return reply.status(200).send({ ok: true, event: eventType, deduped: true });
        }
      }

      try {
        const action = isRecord(payload) && typeof payload.action === "string" ? payload.action : undefined;
        const allowedActions = MENTION_ACTIONS[eventType];
        if (!allowedActions || !action || !allowedActions.includes(action)) {
          return reply.status(200).send({ ok: true, event: eventType, handled: false });
        }
        const mentionsRouted = await handleMentionDelegation(app, orgId, eventType, payload);
        return reply.status(200).send({ ok: true, event: eventType, mentionsRouted });
      } catch (err) {
        // Release the claim so GitHub's retry can re-process. On permanent
        // 4xx failures GitHub does not retry, so the freed row is harmless;
        // on transient 5xx the retry needs the slot back to succeed.
        if (deliveryId) {
          await unclaimEvent(app.db, deliveryId, "github").catch((unclaimErr) => {
            log.error({ err: unclaimErr, deliveryId }, "failed to unclaim GitHub delivery after handler error");
          });
        }
        throw err;
      }
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
async function handleMentionDelegation(
  app: FastifyInstance,
  organizationId: string,
  eventType: string,
  payload: unknown,
): Promise<number> {
  const mentionText = extractEventText(eventType, payload);
  const textMentions = extractMentions(mentionText);
  const structuralMentions = extractStructuralMentions(eventType, payload);
  const mentions = [...new Set([...textMentions, ...structuralMentions])];
  if (mentions.length === 0) return 0;

  const ctx = extractEventContext(eventType, payload);
  if (!ctx) return 0;

  const entity = extractEventEntity(eventType, payload);
  if (!entity) {
    log.warn({ eventType }, "mention extracted but no entity resolvable; skipping fan-out");
    return 0;
  }

  // `Fixes #N` is only meaningful on PR bodies (§4.5). Other event types
  // (issue/discussion/commit-comment) deliberately do not parse — closing
  // keywords appearing in an issue body are conversational, not link
  // intent, and would otherwise mis-cluster.
  const relatedRefs =
    eventType === "pull_request" && ctx.repository.length > 0 ? parseFixesRefs(ctx.body, ctx.repository) : [];

  return routeMentionDelegations(app, organizationId, mentions, ctx, entity, relatedRefs);
}

/** Actions that represent new/changed content (worth scanning for @mentions).
 * Note: `pull_request.review_requested` doesn't carry an @mention in any
 * text body — the reviewer is in `requested_reviewer.login`. We pick it up
 * via `extractStructuralMentions`. The complementary `review_request_removed`
 * is intentionally omitted to avoid notifying the reviewer twice. */
const MENTION_ACTIONS: Record<string, string[]> = {
  issues: ["opened", "edited"],
  issue_comment: ["created"],
  pull_request: ["opened", "edited", "review_requested"],
  pull_request_review: ["submitted"],
  pull_request_review_comment: ["created"],
  discussion: ["created", "edited"],
  discussion_comment: ["created"],
  commit_comment: ["created"],
};
