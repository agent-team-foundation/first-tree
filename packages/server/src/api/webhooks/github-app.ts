import { createHmac, timingSafeEqual } from "node:crypto";
import { githubAppInstallationPermissionsSchema, type ScmIngressContext } from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { BadRequestError, UnauthorizedError } from "../../errors.js";
import { createLogger } from "../../observability/index.js";
import { handleContextReviewerPrEvent } from "../../services/context-reviewer-pr.js";
import type { AppInstallation } from "../../services/github-app.js";
import {
  deleteInstallationByGithubId,
  findInstallationByGithubId,
  markInstallationSuspended,
  markInstallationUnsuspended,
  upsertInstallationFromMetadata,
} from "../../services/github-app-installations.js";
import { resolveGithubAudience } from "../../services/github-audience.js";
import { deliverGithubEvent } from "../../services/github-delivery.js";
import { setEntityState, setEntityTitle } from "../../services/github-entity-state.js";
import { normalizeGithubWebhook } from "../../services/github-normalize.js";
import { processScmWebhookDelivery } from "../../services/scm-webhook-processing.js";
import { isRecord, readString } from "./github-entity.js";

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

/**
 * The GitHub-authenticated actor who triggered the webhook. On
 * `installation.created` this is the user who installed the App — the
 * trusted anti-forgery anchor for binding (GitHub only permits installing
 * on an account the sender administers).
 */
function readSenderGithubId(payload: Record<string, unknown>): number | null {
  const sender = isRecord(payload.sender) ? payload.sender : null;
  const id = sender?.id;
  return typeof id === "number" && Number.isFinite(id) ? id : null;
}

/**
 * The user who *requested* the install when it went through GitHub's
 * owner-approval flow — the top-level `requester` block on
 * `installation.created`. In that flow the `sender` is the approving
 * owner, so this is the only GitHub-authenticated link back to the
 * initiator. Absent (null) on direct installs.
 */
function readRequesterGithubId(payload: Record<string, unknown>): number | null {
  const requester = isRecord(payload.requester) ? payload.requester : null;
  const id = requester?.id;
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

function isContextReviewerCandidateEvent(eventType: string, action: string | null): boolean {
  if (eventType === "pull_request") {
    return action === "opened" || action === "synchronize" || action === "ready_for_review";
  }
  if (eventType === "issue_comment") return action === "created";
  if (eventType === "pull_request_review_comment") return action === "created" || action === "edited";
  return false;
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
    case "created": {
      const metadata = parseInstallationMetadata(installation);
      if (!metadata) return "ignored:malformed";
      // Record-only: the row is created UNBOUND, carrying the two
      // GitHub-authenticated anchors the connect panel matches against —
      // the installer (`sender`; GitHub only lets a user install on an
      // account they administer) and, for owner-approval installs, the
      // original `requester`. Binding is never inferred here: a team admin
      // explicitly connects the installation from the Settings panel of
      // the team it should bind to. That panel action is what decides the
      // target team — the webhook cannot know it.
      const installerGithubId = readSenderGithubId(payload);
      const requesterGithubId = readRequesterGithubId(payload);
      await upsertInstallationFromMetadata(app.db, {
        installation: metadata,
        ...(installerGithubId !== null ? { installerGithubId } : {}),
        ...(requesterGithubId !== null ? { requesterGithubId } : {}),
      });
      return "created:recorded";
    }
    case "new_permissions_accepted": {
      const metadata = parseInstallationMetadata(installation);
      if (!metadata) return "ignored:malformed";
      // Metadata refresh only — never re-bind, and don't overwrite the
      // original installer (COALESCE in the upsert preserves it). The
      // `sender` here may be a different admin accepting new permissions.
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
 *      then GitHub normalize → provider-neutral SCM processing seam →
 *      GitHub audience/delivery adapters. The seam best-effort unclaims on
 *      uncaught handler failure so GitHub's retry has a chance to clear.
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
    const organizationId = installation.hubOrganizationId;

    const deliveryHeader = request.headers["x-github-delivery"];
    const deliveryId = typeof deliveryHeader === "string" && deliveryHeader.length > 0 ? deliveryHeader : null;
    const ingress: ScmIngressContext = {
      provider: "github",
      source: {
        organizationId,
        externalId: `installation:${installationId}`,
      },
      stableDeliveryId: deliveryId,
      ingressAuthority: "verified_signature",
    };

    const rawAction = isRecord(payload) ? readString(payload.action) : null;
    const normalized = normalizeGithubWebhook(eventType, payload, ingress);
    const shouldRunContextReviewer = isContextReviewerCandidateEvent(eventType, rawAction);
    if (!normalized.event && !shouldRunContextReviewer && !normalized.observation) {
      log.debug({ eventType, action: rawAction }, "Stage 1 returned null");
      return reply.status(200).send({ ok: true, event: eventType, handled: false });
    }

    const result = await processScmWebhookDelivery({
      db: app.db,
      ingress,
      observation: normalized.observation,
      event: normalized.event,
      applyObservation: async (current) => {
        if (current.state) {
          await setEntityState(app.db, {
            organizationId,
            entityType: current.entity.type,
            entityKey: current.entity.key,
            state: current.state,
          });
        }
        if (current.entity.title) {
          await setEntityTitle(app.db, {
            organizationId,
            entityType: current.entity.type,
            entityKey: current.entity.key,
            title: current.entity.title,
          });
        }
      },
      runProviderWork: () =>
        shouldRunContextReviewer
          ? handleContextReviewerPrEvent(app, {
              eventType,
              payload,
              organizationId,
            })
          : Promise.resolve({ handled: false, reason: "unsupported_event" } as const),
      resolveAudience: (normalizedEvent) => resolveGithubAudience(app.db, normalizedEvent),
      deliver: (normalizedEvent, audience) =>
        deliverGithubEvent(app, normalizedEvent, audience.targets, {
          entityStateSeed: normalized.entityStateSeed,
          actorHumanId: audience.actorHumanId,
        }),
    });

    switch (result.outcome) {
      case "duplicate":
        return reply.status(200).send({ ok: true, event: eventType, deduped: true });
      case "provider_only":
        log.debug({ eventType, action: rawAction }, "Stage 1 returned null");
        return reply
          .status(200)
          .send({ ok: true, event: eventType, handled: false, contextReviewer: result.providerResult });
      case "audience_empty": {
        const reason =
          result.reason === "audience_empty_with_targets"
            ? "audience_empty_with_involves"
            : "audience_empty_no_involves";
        return reply.status(200).send({
          ok: true,
          event: eventType,
          audience: 0,
          reason,
          contextReviewer: result.providerResult,
        });
      }
      case "delivered":
        return reply.status(200).send({
          ok: true,
          event: eventType,
          ...result.deliveryStats,
          contextReviewer: result.providerResult,
        });
    }
  });
}
