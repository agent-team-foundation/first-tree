import type { NormalizedScmEvent, ScmEntityObservation, ScmIngressContext } from "@first-tree/shared";
import type { Database } from "../db/connection.js";
import { createLogger } from "../observability/index.js";
import { claimEvent, markEventDone, unclaimEvent } from "./event-dedup.js";

const log = createLogger("ScmWebhookProcessing");

export type ScmAudienceResolution<TTarget> = {
  targets: TTarget[];
  actorHumanId: string | null;
};

export type ScmProcessingResult<TDeliveryStats, TProviderResult> =
  | { outcome: "duplicate" }
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
 * only the existing optional whole-request claim, provider work covered by
 * that claim, audience orchestration, and claim lifecycle on exit. Provider
 * payloads, stores, mapping rules, card shapes, and per-chat failure guards
 * remain behind the supplied callbacks.
 *
 * Claim lifecycle (#317): a claimed delivery starts as `pending` with a TTL.
 * Every successful outcome (delivered / audience_empty / provider_only)
 * marks the claim `done`, which is what redeliveries dedupe against. An
 * uncaught top-level failure still best-effort unclaims so GitHub's retry
 * clears quickly — but correctness never depends on that delete: a crashed
 * process leaves an expired `pending` claim that the next delivery takes
 * over atomically (see event-dedup.ts).
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

  // Successful exit from the seam: flip the claim to `done` so redeliveries
  // dedupe against a completed state rather than an in-flight one. If the
  // update itself fails, the catch below best-effort unclaims and rethrows
  // so the provider redelivers and the event is reprocessed.
  const succeed = async (
    result: ScmProcessingResult<TDeliveryStats, TProviderResult>,
  ): Promise<ScmProcessingResult<TDeliveryStats, TProviderResult>> => {
    if (deliveryId) {
      await markEventDone(input.db, deliveryId, input.ingress.provider);
    }
    return result;
  };

  try {
    const providerResult = await input.runProviderWork();
    if (input.observation) {
      await input.applyObservation(input.observation).catch((err) => {
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
      });
    }
    if (!input.event) return succeed({ outcome: "provider_only", providerResult });

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
      return succeed({ outcome: "audience_empty", reason, providerResult });
    }

    const deliveryStats = await input.deliver(input.event, audience);
    return succeed({ outcome: "delivered", deliveryStats, providerResult });
  } catch (err) {
    if (deliveryId) {
      await unclaimEvent(input.db, deliveryId, input.ingress.provider).catch((unclaimErr) => {
        log.error(
          { err: unclaimErr, provider: input.ingress.provider, deliveryId },
          "failed to unclaim SCM webhook delivery after handler error",
        );
      });
    }
    throw err;
  }
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
