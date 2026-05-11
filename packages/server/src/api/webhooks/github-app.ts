import type { FastifyInstance, FastifyReply } from "fastify";
import { BadRequestError, UnauthorizedError } from "../../errors.js";
import { createLogger } from "../../observability/index.js";
import { claimEvent, unclaimEvent } from "../../services/adapter-mapping.js";
import {
  deleteInstallationByGithubId,
  findInstallationByGithubId,
  markInstallationSuspended,
  markInstallationUnsuspended,
  upsertInstallationFromMetadata,
} from "../../services/github-app-installations.js";
import {
  handleIssueCommentEvent,
  handleIssuesEvent,
  handleMentionDelegation,
  MENTION_ACTIONS,
  verifyGithubWebhookSignature,
} from "./github.js";

const log = createLogger("GithubAppWebhook");

/**
 * GitHub App webhook endpoint. One URL for the entire SaaS deployment;
 * the per-org routing is reconstructed by reverse-lookup of
 * `installation.id` → `github_app_installations.hub_organization_id`.
 *
 * Replaces the per-repo `/api/v1/webhooks/github/<orgId>` endpoint
 * (deleted in D3 cutover later in this PR). The downstream pipeline —
 * `github-adapter` agent, `handleIssuesEvent` / `handleIssueCommentEvent`,
 * mention delegation — is identical; only the ingress changes.
 *
 * Event dispatch:
 *
 *   ping                            — 200 ok, no-op.
 *   installation                    — drive the install state machine
 *                                     (create / delete / suspend / unsuspend
 *                                     / new_permissions_accepted). No org
 *                                     routing needed — this event manages
 *                                     the binding itself.
 *   installation_repositories       — re-snapshot installation metadata.
 *                                     Per-repo children table is not yet
 *                                     modelled (design doc §6 punt).
 *   issues / issue_comment / pull_request / etc.
 *                                   — reverse-lookup the org binding then
 *                                     reuse the legacy handler logic. If
 *                                     no binding exists (orphan webhook),
 *                                     200 ok with `routed:false` so GitHub
 *                                     doesn't retry forever.
 */
export async function githubAppWebhookRoutes(app: FastifyInstance): Promise<void> {
  // Scoped buffer parser — same pattern as the legacy `github.ts` plugin.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  const webhookMax = app.config.rateLimit?.webhookMax ?? 60;
  const appCfg = app.config.oauth?.githubApp;

  if (!appCfg) {
    app.log.info(
      "GitHub App not configured — /webhooks/github will return 501. Set FIRST_TREE_HUB_GITHUB_APP_* to enable.",
    );
  }

  app.post(
    "/github",
    { config: { rateLimit: { max: webhookMax, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!appCfg) {
        return reply.status(501).send({
          error: "GitHub App is not configured on this hub. Set FIRST_TREE_HUB_GITHUB_APP_* env vars.",
        });
      }

      const rawBody = request.body;
      if (!Buffer.isBuffer(rawBody)) {
        throw new BadRequestError("Expected raw body buffer");
      }

      // HMAC verification reuses the legacy helper bit-for-bit — same
      // algorithm, same timing-safe compare. Only the secret source
      // differs (global env var instead of per-org cipher).
      const signatureHeader = request.headers["x-hub-signature-256"];
      if (typeof signatureHeader !== "string") {
        throw new UnauthorizedError("Missing x-hub-signature-256 header");
      }
      verifyGithubWebhookSignature(appCfg.webhookSecret, rawBody, signatureHeader);

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

      // GitHub sends `ping` once when the App webhook is first wired up.
      // No side effects, skip dedup.
      if (eventType === "ping") {
        return reply.status(200).send({ ok: true, event: "ping" });
      }

      // Idempotency via `x-github-delivery`. Same approach as the
      // per-org endpoint (#283). Apps share the same retry semantics so
      // the dedup table is reused as-is.
      const deliveryHeader = request.headers["x-github-delivery"];
      const deliveryId = typeof deliveryHeader === "string" && deliveryHeader.length > 0 ? deliveryHeader : null;

      if (deliveryId) {
        const claimed = await claimEvent(app.db, deliveryId, "github-app");
        if (!claimed) {
          log.info({ deliveryId, eventType }, "duplicate GitHub App delivery, skipping");
          return reply.status(200).send({ ok: true, event: eventType, deduped: true });
        }
      }

      try {
        // ── Installation lifecycle events ──────────────────────────
        if (eventType === "installation") {
          return await handleInstallationEvent(app, payload, reply);
        }
        if (eventType === "installation_repositories") {
          return await handleInstallationRepositoriesEvent(app, payload, reply);
        }

        // ── All other events: resolve installation → org, dispatch ─
        const installationIdRaw = extractInstallationId(payload);
        if (installationIdRaw === null) {
          // GitHub always includes `installation` on App webhooks for
          // events that aren't App-management lifecycle. Missing it is a
          // payload bug we want to see in logs.
          log.warn({ eventType }, "github app webhook missing installation block");
          return reply.status(200).send({ ok: true, event: eventType, routed: false, reason: "no_installation" });
        }
        const row = await findInstallationByGithubId(app.db, installationIdRaw);
        if (!row || !row.hubOrganizationId) {
          // Orphan webhook — installation row not yet inserted (race with
          // the callback) or never bound to a Hub team. Either way the
          // sender's only sane response is "ack so GitHub doesn't retry
          // forever"; the binding will catch up via OAuth callback or
          // the `installation: created` event.
          log.info(
            { eventType, installationId: installationIdRaw, hasRow: !!row },
            "github app webhook for unbound installation, dropping",
          );
          return reply.status(200).send({ ok: true, event: eventType, routed: false, reason: "no_binding" });
        }
        const organizationId = row.hubOrganizationId;

        if (eventType === "issues") {
          return await handleIssuesEvent(app, organizationId, eventType, payload, reply);
        }
        if (eventType === "issue_comment") {
          return await handleIssueCommentEvent(app, organizationId, eventType, payload, reply);
        }

        // Other events with mention support — delegate via the
        // action-gated path on the legacy module.
        let mentionsRouted = 0;
        const allowedActions = MENTION_ACTIONS[eventType];
        const action = isRecord(payload) && typeof payload.action === "string" ? payload.action : undefined;
        if (allowedActions && action && allowedActions.includes(action)) {
          mentionsRouted = await handleMentionDelegation(app, organizationId, eventType, payload);
        }
        return reply.status(200).send({ ok: true, event: eventType, handled: mentionsRouted > 0, mentionsRouted });
      } catch (err) {
        if (deliveryId) {
          await unclaimEvent(app.db, deliveryId, "github-app").catch((unclaimErr) => {
            log.error({ err: unclaimErr, deliveryId }, "failed to unclaim GitHub App delivery after handler error");
          });
        }
        throw err;
      }
    },
  );
}

/**
 * Reduce a GitHub App webhook `installation` event to one of the five
 * state-machine actions. `action=new_permissions_accepted` lands as a
 * full re-upsert because the permissions block changed; everything else
 * matches the design doc's documented set.
 */
async function handleInstallationEvent(app: FastifyInstance, payload: unknown, reply: FastifyReply): Promise<unknown> {
  const parsed = parseInstallationPayload(payload);
  if (!parsed) {
    throw new BadRequestError("Invalid installation payload");
  }
  switch (parsed.action) {
    case "created":
    case "new_permissions_accepted": {
      await upsertInstallationFromMetadata(app.db, { installation: parsed.installation });
      return reply.status(200).send({ ok: true, event: "installation", action: parsed.action });
    }
    case "deleted": {
      await deleteInstallationByGithubId(app.db, parsed.installation.id);
      return reply.status(200).send({ ok: true, event: "installation", action: "deleted" });
    }
    case "suspend": {
      await markInstallationSuspended(app.db, parsed.installation.id);
      return reply.status(200).send({ ok: true, event: "installation", action: "suspend" });
    }
    case "unsuspend": {
      await markInstallationUnsuspended(app.db, parsed.installation.id);
      return reply.status(200).send({ ok: true, event: "installation", action: "unsuspend" });
    }
    default: {
      // GitHub adds new actions over time (e.g. `request`). Log and ack
      // so they don't retry; the state machine can be extended later
      // without an emergency release.
      log.info({ action: parsed.action }, "unhandled installation action — acked");
      return reply.status(200).send({ ok: true, event: "installation", action: parsed.action, handled: false });
    }
  }
}

/**
 * `installation_repositories: added/removed` arrives whenever the user
 * changes which repos the App is installed on. We don't model per-repo
 * children yet (design doc §6 punt) so the only useful action here is
 * to re-snapshot the installation block, keeping `events` / `permissions`
 * fresh on the parent row.
 */
async function handleInstallationRepositoriesEvent(
  app: FastifyInstance,
  payload: unknown,
  reply: FastifyReply,
): Promise<unknown> {
  const parsed = parseInstallationPayload(payload);
  if (!parsed) {
    throw new BadRequestError("Invalid installation_repositories payload");
  }
  await upsertInstallationFromMetadata(app.db, { installation: parsed.installation });
  return reply.status(200).send({ ok: true, event: "installation_repositories", action: parsed.action });
}

// ── Payload helpers ──────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractInstallationId(payload: unknown): number | null {
  if (!isRecord(payload)) return null;
  const inst = isRecord(payload.installation) ? payload.installation : null;
  if (!inst) return null;
  return typeof inst.id === "number" ? inst.id : null;
}

type ParsedInstallation = {
  action: string;
  installation: {
    id: number;
    accountType: "User" | "Organization";
    accountLogin: string;
    accountGithubId: number;
    permissions: Record<string, "read" | "write" | "admin">;
    events: string[];
    suspendedAt: string | null;
  };
};

function parseInstallationPayload(payload: unknown): ParsedInstallation | null {
  if (!isRecord(payload)) return null;
  const action = typeof payload.action === "string" ? payload.action : null;
  const inst = isRecord(payload.installation) ? payload.installation : null;
  if (!action || !inst) return null;
  const account = isRecord(inst.account) ? inst.account : null;
  if (!account) return null;

  const id = typeof inst.id === "number" ? inst.id : null;
  const accountId = typeof account.id === "number" ? account.id : null;
  const accountLogin = typeof account.login === "string" ? account.login : null;
  const accountType = account.type === "User" || account.type === "Organization" ? account.type : null;
  if (id === null || accountId === null || accountLogin === null || accountType === null) {
    return null;
  }

  const permissions = isRecord(inst.permissions) ? sanitizePermissions(inst.permissions) : {};
  const events = Array.isArray(inst.events) ? inst.events.filter((e): e is string => typeof e === "string") : [];
  const suspendedAt = typeof inst.suspended_at === "string" ? inst.suspended_at : null;

  return {
    action,
    installation: {
      id,
      accountType,
      accountLogin,
      accountGithubId: accountId,
      permissions,
      events,
      suspendedAt,
    },
  };
}

function sanitizePermissions(record: Record<string, unknown>): Record<string, "read" | "write" | "admin"> {
  const out: Record<string, "read" | "write" | "admin"> = {};
  for (const [k, v] of Object.entries(record)) {
    if (v === "read" || v === "write" || v === "admin") {
      out[k] = v;
    }
  }
  return out;
}
