import type { NormalizedScmEvent, ScmEntityObservation, ScmIngressContext } from "@first-tree/shared";
import type { Database } from "../db/connection.js";
import { createLogger } from "../observability/index.js";
import { claimEvent, completeEventClaim } from "./event-dedup.js";

const log = createLogger("ScmWebhookProcessing");

export type ScmAudienceResolution<TTarget> = {
  targets: TTarget[];
  actorHumanId: string | null;
};

export type ScmProcessingResult<TDeliveryStats, TProviderResult> =
  | { outcome: "duplicate" }
  | { outcome: "in_flight"; retryAfterSeconds: number }
  | { outcome: "provider_only"; providerResult: TProviderResult }
  | {
      outcome: "audience_empty";
      reason: "audience_empty_no_targets" | "audience_empty_with_targets";
      providerResult: TProviderResult;
    }
  | { outcome: "delivered"; deliveryStats: TDeliveryStats; providerResult: TProviderResult };

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
 * only the optional whole-request lifecycle claim, provider work covered by
 * that claim, audience orchestration, and fenced completion. Provider
 * payloads, stores, mapping rules, card shapes, and per-chat failure guards
 * remain behind the supplied callbacks.
 */
export async function processScmWebhookDelivery<TTarget, TDeliveryStats, TProviderResult>(
  input: ProcessScmWebhookDeliveryInput<TTarget, TDeliveryStats, TProviderResult>,
): Promise<ScmProcessingResult<TDeliveryStats, TProviderResult>> {
  assertEventMatchesIngress(input.ingress, input.event);

  const deliveryId = input.ingress.stableDeliveryId;
  let claimExpiresAt: Date | null = null;
  if (deliveryId) {
    const claim = await claimEvent(input.db, deliveryId, input.ingress.provider);
    if (claim.outcome === "done") {
      log.info({ provider: input.ingress.provider, deliveryId }, "completed SCM webhook delivery, skipping replay");
      return { outcome: "duplicate" };
    }
    if (claim.outcome === "in_flight") {
      log.info(
        { provider: input.ingress.provider, deliveryId, retryAfterSeconds: claim.retryAfterSeconds },
        "SCM webhook delivery is already in flight",
      );
      return { outcome: "in_flight", retryAfterSeconds: claim.retryAfterSeconds };
    }
    claimExpiresAt = claim.expiresAt;
  }

  const providerResult = await input.runProviderWork();
  if (input.observation) {
    await input.applyObservation(input.observation).catch((err) => {
      // Projection refresh is deliberately independent from notification
      // delivery. A temporary projection failure must not suppress an
      // otherwise valid card or make a provider redelivery duplicate it.
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
    });
  }

  let terminalResult: ScmProcessingResult<TDeliveryStats, TProviderResult>;
  if (!input.event) {
    terminalResult = { outcome: "provider_only", providerResult };
  } else {
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
      terminalResult = { outcome: "audience_empty", reason, providerResult };
    } else {
      const deliveryStats = await input.deliver(input.event, audience);
      terminalResult = { outcome: "delivered", deliveryStats, providerResult };
    }
  }

  if (deliveryId && claimExpiresAt) {
    await completeEventClaim(input.db, deliveryId, input.ingress.provider, claimExpiresAt);
  }
  return terminalResult;
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
