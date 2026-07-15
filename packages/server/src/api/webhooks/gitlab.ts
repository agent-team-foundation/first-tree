import type { FastifyInstance } from "fastify";
import { BadRequestError, NotFoundError } from "../../errors.js";
import {
  findActiveGitlabEndpoint,
  markGitlabInboundSeen,
  markGitlabProcessingFailure,
  markGitlabReviewerSchemaAnomaly,
  markGitlabStableDeliveryObserved,
  observeGitlabReviewersCapability,
  withGitlabIngressFence,
} from "../../services/gitlab-connections.js";
import {
  applyGitlabPersonnelEvidence,
  deliverGitlabCards,
  extractStableGitlabDeliveryId,
  GitlabPersonnelTargetLimitError,
  normalizeGitlabWebhook,
  resolveGitlabAudience,
} from "../../services/gitlab-webhook.js";
import { runDeferredScmCardPostCommitEffects } from "../../services/scm-card-delivery.js";
import { processScmWebhookDelivery } from "../../services/scm-webhook-processing.js";

const MAX_GITLAB_WEBHOOK_BYTES = 512 * 1024;
const GITLAB_CONNECTION_RATE_LIMIT = 120;

export async function gitlabWebhookRoutes(app: FastifyInstance): Promise<void> {
  const endpointByRequest = new WeakMap<object, NonNullable<Awaited<ReturnType<typeof findActiveGitlabEndpoint>>>>();
  const eventHeaderByRequest = new WeakMap<object, string>();
  const failureMarked = new WeakSet<object>();
  app.post<{ Params: { token: string } }>(
    "/gitlab/:token",
    {
      bodyLimit: MAX_GITLAB_WEBHOOK_BYTES,
      config: {
        rateLimit: {
          max: GITLAB_CONNECTION_RATE_LIMIT,
          timeWindow: "1 minute",
          hook: "onRequest",
          groupId: "gitlab-webhook-connection",
          keyGenerator: (request) =>
            endpointByRequest.get(request)?.connection.id ?? `unresolved-gitlab-endpoint:${request.ip}`,
        },
      },
      onRequest: async (request) => {
        const token = request.params.token;
        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return;
        const endpoint = await findActiveGitlabEndpoint(app.db, token);
        if (endpoint) endpointByRequest.set(request, endpoint);
      },
      preParsing: async (request, _reply, payload) => {
        const endpoint = endpointByRequest.get(request);
        if (!endpoint) throw new NotFoundError("GitLab webhook endpoint not found");
        const eventHeader = request.headers["x-gitlab-event"];
        if (typeof eventHeader !== "string" || eventHeader.length === 0 || eventHeader.length > 100) {
          await markGitlabProcessingFailure(
            app.db,
            endpoint.connection.id,
            endpoint.connection.tokenHash,
            "missing_or_invalid_event_header",
          );
          failureMarked.add(request);
          throw new BadRequestError("X-Gitlab-Event is required");
        }
        eventHeaderByRequest.set(request, eventHeader);
        return payload;
      },
      onError: async (request, _reply, error) => {
        if (error.statusCode === 429) return;
        const endpoint = endpointByRequest.get(request);
        if (endpoint && !failureMarked.has(request)) {
          await markGitlabProcessingFailure(
            app.db,
            endpoint.connection.id,
            endpoint.connection.tokenHash,
            "request_rejected",
          ).catch(() => undefined);
        }
      },
    },
    async (request) => {
      const endpoint = endpointByRequest.get(request);
      if (!endpoint) throw new NotFoundError("GitLab webhook endpoint not found");
      const eventHeader = eventHeaderByRequest.get(request);
      if (!eventHeader) throw new BadRequestError("X-Gitlab-Event is required");

      try {
        const normalized = normalizeGitlabWebhook({
          organizationId: endpoint.connection.organizationId,
          connectionId: endpoint.connection.id,
          instanceOrigin: endpoint.connection.instanceOrigin,
          stableDeliveryId: extractStableGitlabDeliveryId(request.headers, endpoint.connection.id),
          eventHeader,
          body: request.body,
        });
        const result = await withGitlabIngressFence(
          app.db,
          endpoint.connection.id,
          endpoint.connection.tokenHash,
          async (tx, fencedConnection) => {
            const applied = applyGitlabPersonnelEvidence(
              normalized,
              fencedConnection.reviewerMode as "unknown" | "assignee" | "reviewers",
            );
            const processed = await processScmWebhookDelivery({
              db: tx,
              ingress: normalized.ingress,
              event: applied.event,
              runProviderWork: async () => {
                await markGitlabInboundSeen(tx, endpoint.connection.id, endpoint.connection.tokenHash);
                if (normalized.ingress.stableDeliveryId) {
                  await markGitlabStableDeliveryObserved(tx, fencedConnection.id);
                }
                if (applied.observeReviewers) {
                  await observeGitlabReviewersCapability(tx, fencedConnection.id);
                }
                if (applied.schemaAnomalyCode) {
                  await markGitlabReviewerSchemaAnomaly(tx, fencedConnection.id, applied.schemaAnomalyCode);
                }
                return { endpointSeen: true };
              },
              resolveAudience: async (event) => {
                if (!normalized.entityIdentity || !applied.event) {
                  return { targets: [], actorHumanId: null };
                }
                return resolveGitlabAudience(tx, {
                  organizationId: fencedConnection.organizationId,
                  connectionId: fencedConnection.id,
                  automaticActionsEnabled: fencedConnection.automaticActionsEnabled,
                  event,
                  entityIdentity: normalized.entityIdentity,
                  skippedBeforeIdentity: applied.skippedBeforeIdentity,
                });
              },
              deliver: async (event, audience) => {
                if (!normalized.entityIdentity) return { delivered: 0, failed: 0, postCommitEffects: [] };
                return deliverGitlabCards(app, {
                  event,
                  identity: normalized.entityIdentity,
                  audience,
                  organizationId: fencedConnection.organizationId,
                  connectionId: fencedConnection.id,
                  database: tx,
                });
              },
            });
            if (processed.outcome === "delivered" && processed.deliveryStats.failed > 0) {
              await markGitlabProcessingFailure(
                tx,
                endpoint.connection.id,
                endpoint.connection.tokenHash,
                "partial_card_delivery_failure",
              );
            }
            return processed;
          },
        );
        if (result.outcome === "delivered") {
          for (const effects of result.deliveryStats.postCommitEffects) {
            await runDeferredScmCardPostCommitEffects(app, effects);
          }
        }
        return { ok: true, outcome: result.outcome };
      } catch (err) {
        if (err instanceof GitlabPersonnelTargetLimitError) {
          failureMarked.add(request);
          throw err;
        }
        await markGitlabProcessingFailure(
          app.db,
          endpoint.connection.id,
          endpoint.connection.tokenHash,
          err instanceof BadRequestError ? "malformed_payload" : "processing_failed",
        ).catch(() => undefined);
        failureMarked.add(request);
        throw err;
      }
    },
  );
}
