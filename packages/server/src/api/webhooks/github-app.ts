import { createHmac, timingSafeEqual } from "node:crypto";
import { githubAppInstallationPermissionsSchema, type WebhookSource } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { BadRequestError, UnauthorizedError } from "../../errors.js";
import { createLogger } from "../../observability/index.js";
import { handleContextReviewerPullRequest } from "../../services/context-reviewer-pr.js";
import { claimEvent, unclaimEvent } from "../../services/event-dedup.js";
import type { AppInstallation } from "../../services/github-app.js";
import {
  deleteInstallationByGithubId,
  findInstallationByGithubId,
  markInstallationSuspended,
  markInstallationUnsuspended,
  upsertInstallationFromMetadata,
} from "../../services/github-app-installations.js";
import { resolveAudience } from "../../services/github-audience.js";
import { deliverNormalizedEvent } from "../../services/github-delivery.js";
import { type EntityStateSeed, setEntityState } from "../../services/github-entity-state.js";
import { normalizeGithubEvent } from "../../services/github-normalize.js";
import { isRecord, readNumber, readString } from "./github-entity.js";

const log = createLogger("GithubAppWebhook");

function verifySignature(secret: string, rawBody: Buffer, signatureHeader: string): void {
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const expectedBuf = Buffer.from(expected, "utf8");
  const receivedBuf = Buffer.from(signatureHeader, "utf8");
  if (expectedBuf.length !== receivedBuf.length || !timingSafeEqual(expectedBuf, receivedBuf)) {
    throw new UnauthorizedError("Invalid webhook signature");
  }
}

function readInstallationId(payload: unknown): number | null {
  if (!isRecord(payload)) return null;
  const installation = isRecord(payload.installation) ? payload.installation : null;
  const id = installation?.id;
  return typeof id === "number" && Number.isFinite(id) ? id : null;
}

function parseInstallationMetadata(installation: Record<string, unknown>): AppInstallation | null {
  const id = installation.id;
  if (typeof id !== "number" || !Number.isFinite(id)) return null;
  const account = isRecord(installation.account) ? installation.account : null;
  if (!account) return null;
  const accountId = account.id;
  const accountLogin = account.login;
  const accountType = account.type;
  if (typeof accountId !== "number" || typeof accountLogin !== "string") return null;
  if (accountType !== "User" && accountType !== "Organization") return null;
  const permissionsParsed = githubAppInstallationPermissionsSchema.safeParse(installation.permissions);
  const permissions = permissionsParsed.success ? permissionsParsed.data : {};
  const events = Array.isArray(installation.events)
    ? installation.events.filter((e): e is string => typeof e === "string")
    : [];
  const suspendedAt = typeof installation.suspended_at === "string" ? installation.suspended_at : null;
  return {
    id,
    accountType,
    accountLogin,
    accountGithubId: accountId,
    permissions,
    events,
    suspendedAt,
  };
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

/**
 * Derive the current PR/Issue state from any payload that carries the entity.
 * This is used only as an INSERT seed for mappings created by the same
 * webhook delivery; it must not update existing rows for non-transition
 * events such as late `opened` deliveries.
 */
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

/**
 * Map lifecycle transitions to persisted `entity_state` updates for rows
 * that already exist. Initial `opened` events are excluded on purpose: a
 * retry or delayed opened delivery must not overwrite a newer draft/closed/
 * merged state.
 */
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
    if (!issue || number === null) return null;
    if (action !== "closed" && action !== "reopened") return null;
    return { entityType: "issue", entityKey: `${repoFullName}#${number}`, state: issueStateFromPayload(issue, action) };
  }
  return null;
}

async function handleInstallationLifecycle(app: FastifyInstance, eventType: string, payload: unknown): Promise<string> {
  if (!isRecord(payload)) return "ignored:malformed";
  // installation_repositories events carry repo add/remove deltas — we do
  // not yet store the repo list per installation, so accept them but no-op.
  if (eventType === "installation_repositories") return "noop";

  const action = typeof payload.action === "string" ? payload.action : null;
  const installation = isRecord(payload.installation) ? payload.installation : null;
  const installationId = installation && typeof installation.id === "number" ? installation.id : null;
  if (!installation || installationId === null) return "ignored:malformed";

  switch (action) {
    case "created":
    case "new_permissions_accepted": {
      const metadata = parseInstallationMetadata(installation);
      if (!metadata) return "ignored:malformed";
      // UPSERT only writes metadata fields; `hub_organization_id` is owned
      // by the OAuth-callback bind path. A webhook arriving before the
      // callback leaves the row unbound (intentional — webhooks don't
      // know which First Tree user installed the App).
      await upsertInstallationFromMetadata(app.db, { installation: metadata });
      return action;
    }
    case "deleted":
      await deleteInstallationByGithubId(app.db, installationId);
      return "deleted";
    case "suspend": {
      const suspendedAtRaw = installation.suspended_at;
      const suspendedAt = typeof suspendedAtRaw === "string" ? new Date(suspendedAtRaw) : new Date();
      await markInstallationSuspended(app.db, installationId, suspendedAt);
      return "suspended";
    }
    case "unsuspend":
      await markInstallationUnsuspended(app.db, installationId, new Date());
      return "unsuspended";
    default:
      return "ignored:unknown-action";
  }
}

/**
 * GitHub App webhook ingestion — single SaaS-wide endpoint. Replaces the
 * legacy `/webhooks/github/:orgId` per-org endpoint. Wiring:
 *
 *   1. HMAC verify (server-level App webhook secret, NOT per-org)
 *   2. ping → 200 fast-path
 *   3. installation / installation_repositories → lifecycle handler, NOT
 *      the normalize pipeline (these events shouldn't fan out as cards)
 *   4. other events → installation.id → hub_organization_id reverse-lookup,
 *      then Stage 1 normalize → claimEvent → Stage 2 audience → Stage 3
 *      deliver. unclaimEvent on handler failure so GitHub's retry has a
 *      chance to clear.
 *
 * Routes return 200 for "ignored" cases (no installation context, not
 * bound, suspended, duplicate delivery) so GitHub doesn't accumulate
 * retries for events the operator can't act on.
 */
export async function githubAppWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  const appConfig = app.config.oauth?.githubApp;
  if (!appConfig?.webhookSecret) {
    // App credentials block isn't configured (self-hosted deployments
    // without the App wired up). Stub the route as 501 so the URL is
    // discoverable but doesn't pretend to work.
    app.post("/github-app", async (_request, reply) =>
      reply.status(501).send({ error: "GitHub App webhook is not configured for this First Tree deployment." }),
    );
    return;
  }
  const webhookSecret = appConfig.webhookSecret;
  const appSlug = appConfig.slug ?? null;

  app.post("/github-app", async (request, reply) => {
    const rawBody = request.body;
    if (!Buffer.isBuffer(rawBody)) {
      throw new BadRequestError("Expected raw body buffer");
    }

    const signatureHeader = request.headers["x-hub-signature-256"];
    if (typeof signatureHeader !== "string") {
      throw new UnauthorizedError("Missing x-hub-signature-256 header");
    }
    verifySignature(webhookSecret, rawBody, signatureHeader);

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

    if (eventType === "ping") {
      return reply.status(200).send({ ok: true, event: "ping" });
    }

    if (eventType === "installation" || eventType === "installation_repositories") {
      const lifecycle = await handleInstallationLifecycle(app, eventType, payload);
      return reply.status(200).send({ ok: true, event: eventType, lifecycle });
    }

    const installationId = readInstallationId(payload);
    if (installationId === null) {
      return reply.status(200).send({ ok: true, event: eventType, ignored: "no installation context" });
    }

    const installation = await findInstallationByGithubId(app.db, installationId);
    if (!installation) {
      log.warn({ installationId, eventType }, "installation not seen, skipping");
      return reply.status(200).send({ ok: true, event: eventType, ignored: "installation not seen" });
    }
    if (!installation.hubOrganizationId) {
      log.warn({ installationId, eventType }, "installation not bound to any First Tree org, skipping");
      return reply.status(200).send({ ok: true, event: eventType, ignored: "installation not bound" });
    }
    if (installation.suspendedAt !== null) {
      return reply.status(200).send({ ok: true, event: eventType, ignored: "suspended" });
    }

    const source: WebhookSource = {
      kind: "github-app-installation",
      installationId,
      organizationId: installation.hubOrganizationId,
    };

    const deliveryHeader = request.headers["x-github-delivery"];
    const deliveryId = typeof deliveryHeader === "string" && deliveryHeader.length > 0 ? deliveryHeader : null;

    // Bypass: sync the upstream PR/Issue lifecycle onto
    // `github_entity_chat_mappings.entity_state`. Runs independently of
    // the normalize/audience/deliver pipeline so this branch never
    // produces an inbox message. The chat-archive sweeper
    // (services/chat-archive.ts) reads this column to decide when to
    // archive. Idempotent under retries — sits before claimEvent on
    // purpose so a retry whose normalized event was already claimed
    // still gets its state column updated.
    let entityStateSeed: EntityStateSeed | null = null;
    if (isRecord(payload)) {
      const repo = isRecord(payload.repository) ? payload.repository : null;
      const repoFullName = readString(repo?.full_name);
      const action = typeof payload.action === "string" ? payload.action : null;
      if (repoFullName && action) {
        entityStateSeed = resolveEntityStateSeed(eventType, action, payload, repoFullName);
        const stateUpdate = resolveEntityStateUpdate(eventType, action, payload, repoFullName);
        if (stateUpdate) {
          try {
            const stats = await setEntityState(app.db, {
              organizationId: installation.hubOrganizationId,
              entityType: stateUpdate.entityType,
              entityKey: stateUpdate.entityKey,
              state: stateUpdate.state,
            });
            if (stats.updated > 0) {
              log.info(
                { entityKey: stateUpdate.entityKey, state: stateUpdate.state, rows: stats.updated },
                "synced github entity state",
              );
            }
          } catch (err) {
            // Best-effort: state-sync failure must not block normalize/deliver.
            log.error(
              { err, entityKey: stateUpdate.entityKey, state: stateUpdate.state },
              "failed to sync github entity state",
            );
          }
        }
      }
    }

    const event = normalizeGithubEvent(eventType, payload, source, deliveryId);
    if (!event) {
      log.debug({ eventType, action: isRecord(payload) ? payload.action : null }, "Stage 1 returned null");
      return reply.status(200).send({ ok: true, event: eventType, handled: false });
    }

    if (deliveryId) {
      const claimed = await claimEvent(app.db, deliveryId, "github");
      if (!claimed) {
        log.info({ deliveryId, eventType }, "duplicate delivery, skipping");
        return reply.status(200).send({ ok: true, event: eventType, deduped: true });
      }
    }

    try {
      const contextReviewer = await handleContextReviewerPullRequest(app, {
        eventType,
        payload,
        organizationId: installation.hubOrganizationId,
      });

      const audience = await resolveAudience(app.db, event, appSlug);
      if (audience.length === 0) {
        // Distinguish "expected nobody" (no involves, no subscription)
        // from "had explicit involves but resolved to zero agents" — the
        // latter usually means a mentioned GitHub login has no
        // `delegateMention`-configured agent in this org, which is a
        // potential mis-configuration worth surfacing on a dashboard.
        // See #507.
        const reason: "audience_empty_no_involves" | "audience_empty_with_involves" =
          event.involves.length > 0 ? "audience_empty_with_involves" : "audience_empty_no_involves";
        log.info(
          {
            entityType: event.entity.type,
            entityKey: event.entity.key,
            actor: event.actor.githubLogin,
            involvesCount: event.involves.length,
            reason,
          },
          "audience empty, skipping",
        );
        return reply.status(200).send({ ok: true, event: eventType, audience: 0, reason, contextReviewer });
      }
      const stats = await deliverNormalizedEvent(app, event, audience, { entityStateSeed });
      return reply.status(200).send({ ok: true, event: eventType, ...stats, contextReviewer });
    } catch (err) {
      if (deliveryId) {
        await unclaimEvent(app.db, deliveryId, "github").catch((unclaimErr) => {
          log.error({ err: unclaimErr, deliveryId }, "failed to unclaim delivery after handler error");
        });
      }
      throw err;
    }
  });
}
