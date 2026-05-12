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
 *                                   — reverse-lookup the org binding FIRST
 *                                     (before claiming the delivery for
 *                                     dedup — codex P1-6), then reuse the
 *                                     legacy handler logic. If no binding
 *                                     exists yet (webhook racing ahead of
 *                                     the OAuth-callback bind), reply 503
 *                                     WITHOUT claiming so GitHub redelivers
 *                                     once the bind lands.
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
      // the dedup table is reused as-is. GitHub keeps the delivery GUID
      // stable across its own redeliveries, so claiming/dedup survives
      // retries.
      const deliveryHeader = request.headers["x-github-delivery"];
      const deliveryId = typeof deliveryHeader === "string" && deliveryHeader.length > 0 ? deliveryHeader : null;

      // claimEvent helper: insert the dedup row; on conflict (already
      // processed) short-circuit with a deduped 200. Returns `true` when
      // the caller may proceed, `false` when it already wrote the reply
      // (the caller then just `return reply`).
      const tryClaim = async (): Promise<boolean> => {
        if (!deliveryId) return true;
        const claimed = await claimEvent(app.db, deliveryId, "github-app");
        if (!claimed) {
          log.info({ deliveryId, eventType }, "duplicate GitHub App delivery, skipping");
          reply.status(200).send({ ok: true, event: eventType, deduped: true });
          return false;
        }
        return true;
      };
      const releaseClaimOnError = async (err: unknown): Promise<never> => {
        if (deliveryId) {
          await unclaimEvent(app.db, deliveryId, "github-app").catch((unclaimErr) => {
            log.error({ err: unclaimErr, deliveryId }, "failed to unclaim GitHub App delivery after handler error");
          });
        }
        throw err;
      };

      // ── Installation lifecycle events ────────────────────────────────
      // These events MANAGE the binding (create / delete / suspend / …),
      // so there's no "wait for the bind" race — claim + handle.
      if (eventType === "installation" || eventType === "installation_repositories") {
        if (!(await tryClaim())) return reply;
        try {
          return eventType === "installation"
            ? await handleInstallationEvent(app, payload, reply)
            : await handleInstallationRepositoriesEvent(app, payload, reply);
        } catch (err) {
          return releaseClaimOnError(err);
        }
      }

      // ── All other events: resolve installation → org BEFORE claiming ──
      // (codex P1-6) The old order claimed first, so an `issues` /
      // `pull_request` event that arrived in the window between
      // `installation: created` and the OAuth-callback bind got burned as
      // "processed" while returning 200 — GitHub then never redelivered
      // it. Now we look up the binding first; if it's not there yet, we
      // 503 WITHOUT claiming, so GitHub redelivers (the bind almost
      // certainly lands within seconds of the OAuth round-trip) and the
      // redelivery — same GUID, still unclaimed — gets a second chance.
      const installationIdRaw = extractInstallationId(payload);
      if (installationIdRaw === null) {
        // GitHub always includes `installation` on App webhooks for events
        // that aren't App-management lifecycle. Missing it is a payload
        // bug a redelivery won't fix — ack (200) and don't claim (claiming
        // is moot, nothing reprocesses an event we can't route).
        log.warn({ eventType }, "github app webhook missing installation block");
        return reply.status(200).send({ ok: true, event: eventType, routed: false, reason: "no_installation" });
      }
      const row = await findInstallationByGithubId(app.db, installationIdRaw);
      if (!row || !row.hubOrganizationId) {
        // Race with the OAuth-callback bind (or a never-bound install).
        // 503 (NOT a deduped/processed 200) so GitHub keeps redelivering
        // on its retry schedule; deliberately NOT claimed so the next
        // attempt is processed fresh. If the bind never lands GitHub
        // eventually gives up — those events were genuinely unroutable.
        log.info(
          { eventType, installationId: installationIdRaw, hasRow: !!row },
          "github app webhook for unbound installation — 503 so GitHub redelivers after the bind lands",
        );
        return reply
          .status(503)
          .send({ ok: false, event: eventType, routed: false, reason: "no_binding", retryable: true });
      }
      const organizationId = row.hubOrganizationId;

      if (!(await tryClaim())) return reply;
      try {
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
        return releaseClaimOnError(err);
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
      // GitHub stamps `installation.suspended_at` on the suspend event;
      // fall back to receive-time only if the field is somehow absent.
      const suspendedAt = parsed.installation.suspendedAt ? new Date(parsed.installation.suspendedAt) : new Date();
      await markInstallationSuspended(app.db, parsed.installation.id, suspendedAt);
      return reply.status(200).send({ ok: true, event: "installation", action: "suspend" });
    }
    case "unsuspend": {
      // The unsuspend payload carries no event timestamp — use receive time.
      await markInstallationUnsuspended(app.db, parsed.installation.id, new Date());
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
