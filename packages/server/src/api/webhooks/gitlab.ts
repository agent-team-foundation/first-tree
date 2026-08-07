import type { FastifyInstance } from "fastify";
import { BadRequestError, NotFoundError } from "../../errors.js";
import { createLogger } from "../../observability/index.js";
import { invalidateChatAudience } from "../../services/chat-audience-cache.js";
import { handleContextReviewerMrEvent } from "../../services/context-reviewer-mr.js";
import {
  findActiveGitlabEndpoint,
  markGitlabInboundSeen,
  markGitlabProcessingFailure,
  markGitlabReviewerSchemaAnomaly,
  markGitlabStableDeliveryObserved,
  markGitlabSystemHookMergeRequestProcessed,
  observeGitlabCompatibility,
  parseDeclaredGitlabVersion,
  resolveGitlabReviewerMode,
  withGitlabIngressFence,
} from "../../services/gitlab-connections.js";
import {
  isGitlabCrossHookDuplicate,
  rememberSuccessfulGitlabHookEvent,
  withGitlabCrossHookDedupFence,
} from "../../services/gitlab-cross-hook-dedup.js";
import {
  normalizeGitlabProjectPath,
  observeGitlabEntityAndResolveFollowers,
  refreshGitlabChatTopics,
} from "../../services/gitlab-entity-follow.js";
import {
  applyGitlabPersonnelEvidence,
  deliverGitlabCards,
  extractStableGitlabDeliveryId,
  GitlabPersonnelTargetLimitError,
  normalizeGitlabWebhook,
  resolveGitlabAudience,
} from "../../services/gitlab-webhook.js";
import { runDeferredSendMessagePostCommitEffects } from "../../services/message.js";
import { notifyRecipients } from "../../services/notifier.js";
import { runDeferredScmCardPostCommitEffects } from "../../services/scm-card-delivery.js";
import { lockGitlabEntityAttention } from "../../services/scm-entity-attention-lock.js";
import { processScmWebhookDelivery } from "../../services/scm-webhook-processing.js";

const MAX_GITLAB_WEBHOOK_BYTES = 512 * 1024;
const GITLAB_CONNECTION_RATE_LIMIT = 120;
const log = createLogger("GitlabWebhookRoute");

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
          log.warn(
            {
              metric: "gitlab_hook_source_unresolved_failure_total",
              connectionId: endpoint.connection.id,
              reason: "missing_or_invalid_event_header",
            },
            "rejected GitLab webhook without a trustworthy hook source",
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
          const eventHeader = eventHeaderByRequest.get(request);
          if (eventHeader === "System Hook") {
            await markGitlabProcessingFailure(
              app.db,
              endpoint.connection.id,
              endpoint.connection.tokenHash,
              "request_rejected",
            ).catch(() => undefined);
          } else {
            log.warn(
              {
                err: error,
                metric: "gitlab_project_hook_processing_failed_total",
                connectionId: endpoint.connection.id,
                reason: "request_rejected",
              },
              "Project Hook request failed without changing System Hook readiness",
            );
          }
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
        const declaredVersion = parseDeclaredGitlabVersion(request.headers["user-agent"]);
        const isSystemHookMergeRequest = eventHeader === "System Hook" && normalized.hookEventKind === "merge_request";
        const execution = await withGitlabCrossHookDedupFence(endpoint.connection.id, async () => {
          let crossHookDuplicate = false;
          let shouldRememberSuccessfulEvent = false;
          const processed = await withGitlabIngressFence(
            app.db,
            endpoint.connection.id,
            endpoint.connection.tokenHash,
            async (tx, fencedConnection) => {
              if (normalized.entityIdentity) {
                await lockGitlabEntityAttention(tx, {
                  connectionId: fencedConnection.id,
                  projectPathNormalized: normalizeGitlabProjectPath(normalized.entityIdentity.projectPath),
                  projectIds: [normalized.entityIdentity.projectId],
                  entityType: normalized.entityIdentity.entityType,
                  entityIid: normalized.entityIdentity.entityIid,
                });
              }
              if (normalized.crossHookFingerprint) {
                crossHookDuplicate = isGitlabCrossHookDuplicate({
                  fingerprint: normalized.crossHookFingerprint,
                  hookSource: normalized.hookSource,
                });
                if (crossHookDuplicate) {
                  log.info(
                    {
                      metric: "gitlab_cross_hook_duplicate_total",
                      connectionId: fencedConnection.id,
                      hookSource: normalized.hookSource,
                    },
                    "skipping duplicate GitLab merge request from the opposite hook source",
                  );
                }
              } else if (normalized.hookEventKind === "merge_request") {
                log.info(
                  {
                    metric: "gitlab_cross_hook_fingerprint_unavailable_total",
                    connectionId: fencedConnection.id,
                    hookSource: normalized.hookSource,
                  },
                  "GitLab merge request lacks a reliable cross-hook occurrence fingerprint",
                );
              }

              const reviewerMode = resolveGitlabReviewerMode({
                currentMode: fencedConnection.reviewerMode as "unknown" | "assignee" | "reviewers",
                declaredVersion,
                reviewerField: normalized.personnel.reviewerField,
              });
              const applied = applyGitlabPersonnelEvidence(normalized, reviewerMode);
              let observedFollowers: Awaited<ReturnType<typeof observeGitlabEntityAndResolveFollowers>> = [];
              const processingResult = await processScmWebhookDelivery({
                db: tx,
                ingress: normalized.ingress,
                observation: crossHookDuplicate ? null : normalized.observation,
                event: crossHookDuplicate ? null : applied.event,
                applyObservation: async () => {
                  if (!normalized.entityIdentity) return;
                  observedFollowers = await observeGitlabEntityAndResolveFollowers(
                    tx,
                    fencedConnection.id,
                    normalized.entityIdentity,
                  );
                  await refreshGitlabChatTopics(tx, fencedConnection.id, normalized.entityIdentity);
                },
                runProviderWork: async () => {
                  await markGitlabInboundSeen(
                    tx,
                    endpoint.connection.id,
                    endpoint.connection.tokenHash,
                    normalized.hookSource,
                  );
                  if (normalized.ingress.stableDeliveryId) {
                    await markGitlabStableDeliveryObserved(tx, fencedConnection.id);
                  }
                  await observeGitlabCompatibility(tx, fencedConnection.id, {
                    declaredVersion: declaredVersion?.value ?? null,
                    reviewerMode,
                    reviewersValid: normalized.personnel.reviewerField === "valid",
                  });
                  if (applied.schemaAnomalyCode) {
                    await markGitlabReviewerSchemaAnomaly(tx, fencedConnection.id, applied.schemaAnomalyCode);
                  }
                  const contextReviewer = crossHookDuplicate
                    ? ({ handled: false, reason: "unsupported_event" } as const)
                    : await handleContextReviewerMrEvent({
                        database: tx,
                        normalized,
                        connection: fencedConnection,
                        staleSeconds: app.config.runtime.presenceCleanupSeconds,
                      });
                  return { endpointSeen: true, contextReviewer };
                },
                resolveAudience: async (event) => {
                  if (!normalized.entityIdentity || !applied.event) {
                    return { targets: [], actorHumanId: null };
                  }
                  return resolveGitlabAudience(tx, {
                    organizationId: fencedConnection.organizationId,
                    connectionId: fencedConnection.id,
                    event,
                    entityIdentity: normalized.entityIdentity,
                    followers: observedFollowers,
                  });
                },
                deliver: async (event, audience) => {
                  if (!normalized.entityIdentity) {
                    return {
                      delivered: 0,
                      failed: 0,
                      postCommitEffects: [],
                      audienceCacheInvalidationChatIds: [],
                    };
                  }
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
              const partialCardDeliveryFailed =
                processingResult.outcome === "delivered" && processingResult.deliveryStats.failed > 0;
              if (isSystemHookMergeRequest && processingResult.outcome !== "duplicate") {
                if (crossHookDuplicate) {
                  await markGitlabSystemHookMergeRequestProcessed(
                    tx,
                    endpoint.connection.id,
                    endpoint.connection.tokenHash,
                  );
                } else if (processingResult.observationOutcome !== "applied") {
                  await markGitlabProcessingFailure(
                    tx,
                    endpoint.connection.id,
                    endpoint.connection.tokenHash,
                    "processing_failed",
                  );
                } else if (partialCardDeliveryFailed) {
                  await markGitlabProcessingFailure(
                    tx,
                    endpoint.connection.id,
                    endpoint.connection.tokenHash,
                    "partial_card_delivery_failure",
                  );
                } else {
                  await markGitlabSystemHookMergeRequestProcessed(
                    tx,
                    endpoint.connection.id,
                    endpoint.connection.tokenHash,
                  );
                }
              } else if (partialCardDeliveryFailed) {
                log.warn(
                  {
                    metric: "gitlab_project_hook_processing_failed_total",
                    connectionId: endpoint.connection.id,
                    reason: "partial_card_delivery_failure",
                  },
                  "Project Hook delivery partially failed without changing System Hook readiness",
                );
              }
              shouldRememberSuccessfulEvent =
                normalized.crossHookFingerprint !== null &&
                !crossHookDuplicate &&
                processingResult.outcome !== "duplicate" &&
                processingResult.observationOutcome === "applied" &&
                !partialCardDeliveryFailed;
              return processingResult;
            },
          );

          if (processed.outcome === "delivered") {
            for (const chatId of processed.deliveryStats.audienceCacheInvalidationChatIds) {
              invalidateChatAudience(chatId);
            }
            for (const effects of processed.deliveryStats.postCommitEffects) {
              await runDeferredScmCardPostCommitEffects(app, effects);
            }
          }
          const contextReviewer = processed.outcome === "duplicate" ? null : processed.providerResult.contextReviewer;
          if (contextReviewer?.handled) {
            await runDeferredSendMessagePostCommitEffects(app.db, contextReviewer.deferredPostCommitEffects);
            notifyRecipients(app.notifier, contextReviewer.recipients, contextReviewer.messageId);
          }
          if (shouldRememberSuccessfulEvent && normalized.crossHookFingerprint) {
            rememberSuccessfulGitlabHookEvent({
              fingerprint: normalized.crossHookFingerprint,
              hookSource: normalized.hookSource,
            });
          }
          return { processed, crossHookDuplicate };
        });
        return {
          ok: true,
          outcome:
            execution.crossHookDuplicate && execution.processed.outcome !== "duplicate"
              ? "cross_hook_duplicate"
              : execution.processed.outcome,
        };
      } catch (err) {
        if (err instanceof GitlabPersonnelTargetLimitError) {
          failureMarked.add(request);
          throw err;
        }
        const failureCode = err instanceof BadRequestError ? "malformed_payload" : "processing_failed";
        if (eventHeader === "System Hook") {
          await markGitlabProcessingFailure(
            app.db,
            endpoint.connection.id,
            endpoint.connection.tokenHash,
            failureCode,
          ).catch(() => undefined);
        } else {
          log.warn(
            {
              err,
              metric: "gitlab_project_hook_processing_failed_total",
              connectionId: endpoint.connection.id,
              reason: failureCode,
            },
            "Project Hook processing failed without changing System Hook readiness",
          );
        }
        failureMarked.add(request);
        throw err;
      }
    },
  );
}
