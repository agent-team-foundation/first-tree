import type { FastifyInstance } from "fastify";
import { BadRequestError, NotFoundError } from "../../errors.js";
import {
  findActiveGitlabEndpoint,
  markGitlabInboundSeen,
  markGitlabProcessingFailure,
  withGitlabIngressFence,
} from "../../services/gitlab-connections.js";
import {
  deliverGitlabBasicCards,
  extractStableGitlabDeliveryId,
  normalizeGitlabWebhook,
  observeGitlabReviewerCapability,
  resolveGitlabBasicAudience,
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
          await markGitlabProcessingFailure(app.db, endpoint.connection.id, "missing_or_invalid_event_header");
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
          await markGitlabProcessingFailure(app.db, endpoint.connection.id, "request_rejected").catch(() => undefined);
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
          endpoint.endpoint.id,
          async (tx, fencedConnection) => {
            const processed = await processScmWebhookDelivery({
              db: tx,
              ingress: normalized.ingress,
              event: normalized.event,
              runProviderWork: async () => {
                await markGitlabInboundSeen(tx, endpoint.connection.id, endpoint.endpoint.id);
                await observeGitlabReviewerCapability(tx, endpoint.connection.id, normalized.reviewerCapability);
                return { endpointGeneration: endpoint.endpoint.generation };
              },
              resolveAudience: async () => {
                if (!normalized.entityIdentity || fencedConnection.recoveryPending) {
                  return { targets: [], actorHumanId: null };
                }
                return resolveGitlabBasicAudience(
                  tx,
                  endpoint.connection.organizationId,
                  endpoint.connection.id,
                  normalized.entityIdentity,
                );
              },
              deliver: async (event, audience) => {
                if (!normalized.entityIdentity) return { delivered: 0, failed: 0, postCommitEffects: [] };
                return deliverGitlabBasicCards(app, event, normalized.entityIdentity, audience, tx);
              },
            });
            if (processed.outcome === "delivered" && processed.deliveryStats.failed > 0) {
              await markGitlabProcessingFailure(tx, endpoint.connection.id, "partial_card_delivery_failure");
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
        await markGitlabProcessingFailure(
          app.db,
          endpoint.connection.id,
          err instanceof BadRequestError ? "malformed_payload" : "processing_failed",
        ).catch(() => undefined);
        failureMarked.add(request);
        throw err;
      }
    },
  );
}
