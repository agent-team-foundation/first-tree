import type { NormalizedScmEvent, ScmEntityObservation, ScmIngressContext } from "@first-tree/shared";
import type { Database } from "../db/connection.js";
import { createLogger } from "../observability/index.js";
import { claimEvent, completeEvent, unclaimEvent } from "./event-dedup.js";

const log = createLogger("ScmWebhookProcessing");

export type ScmAudienceResolution<TTarget> = {
  targets: TTarget[];
  actorHumanId: string | null;
};

export type ScmObservationOutcome = "not_applicable" | "applied" | "failed";

export type ScmProcessingResult<TDeliveryStats, TProviderResult> =
  | { outcome: "duplicate" }
  | {
      outcome: "provider_only";
      observationOutcome: ScmObservationOutcome;
      providerResult: TProviderResult;
    }
  | {
      outcome: "audience_empty";
      reason: "audience_empty_no_targets" | "audience_empty_with_targets";
      observationOutcome: ScmObservationOutcome;
      providerResult: TProviderResult;
    }
  | {
      outcome: "delivered";
      deliveryStats: TDeliveryStats;
      observationOutcome: ScmObservationOutcome;
      providerResult: TProviderResult;
    };

type ProcessScmWebhookDeliveryInput<TTarget, TDeliveryStats, TProviderResult> = {
  db: Database;
  ingress: ScmIngressContext;
  observation: ScmEntityObservation | null;
  event: NormalizedScmEvent | null;
  applyObservation: (observation: ScmEntityObservation) => Promise<void>;
  /** Provider-owned work covered by the same whole-request claim. */
  runProviderWork: () => Promise<TProviderResult>;
  /** Provider-owned mapping and identity resolver. */
  resolveAudience: (event: NormalizedScmEvent) => Promise<ScmAudienceResolution<TTarget>>;
  /** Provider-owned card/chat delivery. Per-target/chat failures stay isolated here. */
  deliver: (event: NormalizedScmEvent, audience: ScmAudienceResolution<TTarget>) => Promise<TDeliveryStats>;
};

/**
 * Narrow provider-neutral SCM processing seam.
 *
 * The ingress adapter authenticates and normalizes first. This kernel owns
 * only the optional whole-request claim lifecycle (pending claim before the
 * work, done mark after it, best-effort unclaim on an uncaught top-level
 * failure), provider work covered by that claim, and audience orchestration.
 * Provider payloads, stores, mapping rules, card shapes, and per-chat
 * failure guards remain behind the supplied callbacks.
 *
 * Claim semantics: the pending claim carries a TTL, so a crash that skips
 * both the done mark and the unclaim leaves a claim that expires instead of
 * deduping the event forever — a later redelivery takes the expired claim
 * over and reprocesses.
 */
export async function processScmWebhookDelivery<TTarget, TDeliveryStats, TProviderResult>(
  input: ProcessScmWebhookDeliveryInput<TTarget, TDeliveryStats, TProviderResult>,
): Promise<ScmProcessingResult<TDeliveryStats, TProviderResult>> {
  assertEventMatchesIngress(input.ingress, input.event);

  const deliveryId = input.ingress.stableDeliveryId;
  if (deliveryId) {
    const claimed = await claimEvent(input.db, deliveryId, input.ingress.provider);
    if (!claimed) {
      log.info({ provider: input.ingress.provider, deliveryId }, "duplicate SCM webhook delivery, skipping");
      return { outcome: "duplicate" };
    }
  }

  let result: ScmProcessingResult<TDeliveryStats, TProviderResult>;
  try {
    result = await runClaimedWork(input);
  } catch (err) {
    if (deliveryId) {
      // Best-effort optimization so the provider's immediate retry can
      // clear without waiting out the claim TTL. Correctness does not
      // depend on this delete: an untouched pending claim expires.
      await unclaimEvent(input.db, deliveryId, input.ingress.provider).catch((unclaimErr) => {
        log.error(
          { err: unclaimErr, provider: input.ingress.provider, deliveryId },
          "failed to unclaim SCM webhook delivery after handler error",
        );
      });
    }
    throw err;
  }

  if (deliveryId) {
    // Flip the pending claim to done so redeliveries dedupe permanently.
    // A failure here is not fatal: the side effects already landed, and the
    // worst case is a redelivery after the claim expires (at-least-once).
    try {
      const completed = await completeEvent(input.db, deliveryId, input.ingress.provider);
      if (!completed) {
        log.warn(
          { provider: input.ingress.provider, deliveryId },
          "SCM webhook claim disappeared before completion; a redelivery may reprocess this event",
        );
      }
    } catch (err) {
      log.error(
        { err, provider: input.ingress.provider, deliveryId },
        "failed to mark SCM webhook delivery done; a redelivery may reprocess this event after the claim expires",
      );
    }
  }
  return result;
}

async function runClaimedWork<TTarget, TDeliveryStats, TProviderResult>(
  input: ProcessScmWebhookDeliveryInput<TTarget, TDeliveryStats, TProviderResult>,
): Promise<ScmProcessingResult<TDeliveryStats, TProviderResult>> {
  const providerResult = await input.runProviderWork();
  let observationOutcome: ScmObservationOutcome = "not_applicable";
  if (input.observation) {
    try {
      await input.applyObservation(input.observation);
      observationOutcome = "applied";
    } catch (err) {
      observationOutcome = "failed";
      // Projection refresh is deliberately independent from notification
      // delivery. A temporary projection failure must not suppress an
      // otherwise valid card or make a provider retry duplicate it.
      log.error(
        {
          err,
          provider: input.ingress.provider,
          organizationId: input.ingress.source.organizationId,
          entityType: input.observation?.entity.type,
          entityKey: input.observation?.entity.key,
        },
        "failed to apply SCM entity observation",
      );
    }
  }
  if (!input.event) return { outcome: "provider_only", observationOutcome, providerResult };

  const audience = await input.resolveAudience(input.event);
  if (audience.targets.length === 0) {
    const reason = input.event.targets.length > 0 ? "audience_empty_with_targets" : "audience_empty_no_targets";
    log.info(
      {
        provider: input.event.provider,
        organizationId: input.event.source.organizationId,
        entityType: input.event.entity.type,
        entityKey: input.event.entity.key,
        actor: input.event.actor.externalUsername,
        targetsCount: input.event.targets.length,
        reason,
      },
      "SCM webhook audience empty, skipping",
    );
    return { outcome: "audience_empty", reason, observationOutcome, providerResult };
  }

  const deliveryStats = await input.deliver(input.event, audience);
  return { outcome: "delivered", deliveryStats, observationOutcome, providerResult };
}

function assertEventMatchesIngress(ingress: ScmIngressContext, event: NormalizedScmEvent | null): void {
  if (!event) return;
  if (
    event.provider !== ingress.provider ||
    event.source.organizationId !== ingress.source.organizationId ||
    event.source.externalId !== ingress.source.externalId ||
    event.stableDeliveryId !== ingress.stableDeliveryId ||
    event.ingressAuthority !== ingress.ingressAuthority
  ) {
    throw new Error("normalized SCM event does not match its ingress context");
  }
}
