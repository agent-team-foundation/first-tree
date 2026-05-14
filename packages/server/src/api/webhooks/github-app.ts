import { createHmac, timingSafeEqual } from "node:crypto";
import {
  githubAppInstallationPermissionsSchema,
  type WebhookSource,
} from "@agent-team-foundation/first-tree-hub-shared";
import type { FastifyInstance } from "fastify";
import { BadRequestError, UnauthorizedError } from "../../errors.js";
import { createLogger } from "../../observability/index.js";
import { claimEvent, unclaimEvent } from "../../services/adapter-mapping.js";
import type { AppInstallation } from "../../services/github-app.js";
import {
  deleteInstallationByGithubId,
  findInstallationByGithubId,
  markInstallationSuspended,
  markInstallationUnsuspended,
  upsertInstallationFromMetadata,
} from "../../services/github-app-installations.js";
import { archiveChatsForMergedPr } from "../../services/github-archive-on-merge.js";
import { resolveAudience } from "../../services/github-audience.js";
import { deliverNormalizedEvent } from "../../services/github-delivery.js";
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
      // know which Hub user installed the App).
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
      reply.status(501).send({ error: "GitHub App webhook is not configured for this Hub deployment." }),
    );
    return;
  }
  const webhookSecret = appConfig.webhookSecret;
  const appSlug = appConfig.slug ?? null;
  const webhookMax = app.config.rateLimit?.webhookMax ?? 600;

  app.post(
    "/github-app",
    { config: { rateLimit: { max: webhookMax, timeWindow: "1 minute" } } },
    async (request, reply) => {
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
        log.warn({ installationId, eventType }, "installation not bound to any hub org, skipping");
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

      // Bypass: PR merged → auto-archive every chat bound to this PR for the
      // owning humans. Runs independently of the normalize/audience/deliver
      // pipeline (which still drops pull_request.closed in Stage 1) so this
      // never produces an inbox message. Idempotent under retries — sits
      // before claimEvent on purpose so the archive does not get dropped on
      // a retry whose normalized event was already claimed by a previous
      // delivery attempt.
      if (eventType === "pull_request" && isRecord(payload) && payload.action === "closed") {
        const pr = isRecord(payload.pull_request) ? payload.pull_request : null;
        const repo = isRecord(payload.repository) ? payload.repository : null;
        const repoFullName = readString(repo?.full_name);
        const prNumber = readNumber(pr?.number);
        const isMerged = pr?.merged === true;
        if (isMerged && repoFullName && prNumber !== null) {
          try {
            const stats = await archiveChatsForMergedPr(app.db, {
              organizationId: installation.hubOrganizationId,
              repoFullName,
              prNumber,
            });
            log.info({ entityKey: `${repoFullName}#${prNumber}`, ...stats }, "auto-archived chats on PR merge");
          } catch (err) {
            // Best-effort: archive failure must not block normalize/deliver.
            log.error({ err, repoFullName, prNumber }, "failed to auto-archive chats on PR merge");
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
        const audience = await resolveAudience(app.db, event, appSlug);
        if (audience.length === 0) {
          log.info(
            { entityType: event.entity.type, entityKey: event.entity.key, actor: event.actor.githubLogin },
            "audience empty, skipping",
          );
          return reply.status(200).send({ ok: true, event: eventType, audience: 0 });
        }
        const stats = await deliverNormalizedEvent(app, event, audience);
        return reply.status(200).send({ ok: true, event: eventType, ...stats });
      } catch (err) {
        if (deliveryId) {
          await unclaimEvent(app.db, deliveryId, "github").catch((unclaimErr) => {
            log.error({ err: unclaimErr, deliveryId }, "failed to unclaim delivery after handler error");
          });
        }
        throw err;
      }
    },
  );
}
