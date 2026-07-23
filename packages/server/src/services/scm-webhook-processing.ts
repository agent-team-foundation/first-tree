import type { NormalizedScmEvent, ScmEntityObservation, ScmIngressContext } from "@first-tree/shared";
import type { Database } from "../db/connection.js";
import { createLogger } from "../observability/index.js";
import {
  claimEvent,
  completeEvent,
  readClaimState,
  releaseClaimedEvent,
  type WebhookClaimState,
} from "./event-dedup.js";

const log = createLogger("ScmWebhookProcessing");

export type ScmAudienceResolution<TTarget> = {
  targets: TTarget[];
  actorHumanId: string | null;
};

export type ScmProcessingResult<TDeliveryStats, TProviderResult> =
  | {
      outcome: "duplicate";
      /**
       * Claim state behind the dedupe: `pending` means an attempt owns the
       * delivery until its TTL expires (redeliver after that to take over),
       * `done` means it was fully processed. Null in the rare case the row
       * disappeared between the claim attempt and the diagnostic read.
       */
      claimState: WebhookClaimState | null;
    }
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
  /** Claim lease TTL: how long a pending claim shields the delivery from
   * duplicates before a redelivery may take it over. */
  claimTtlSeconds: number;
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
 * only the optional whole-request claim lease (claimed `pending` up front,
 * marked `done` on success, released to expired on an uncaught top-level
 * failure — with expired pending claims taken over by a later redelivery),
 * provider work covered by that claim, and audience orchestration. Provider
 * payloads, stores, mapping rules, card shapes, and per-chat failure guards
 * remain behind the supplied callbacks.
 *
 * Deliveries without a stable id skip the claim entirely, and symmetrically
 * skip complete/release: those calls run only while this attempt actually
 * holds the claim token.
 */
export async function processScmWebhookDelivery<TTarget, TDeliveryStats, TProviderResult>(
  input: ProcessScmWebhookDeliveryInput<TTarget, TDeliveryStats, TProviderResult>,
): Promise<ScmProcessingResult<TDeliveryStats, TProviderResult>> {
  assertEventMatchesIngress(input.ingress, input.event);

  const deliveryId = input.ingress.stableDeliveryId;
  let claimToken: string | null = null;
  if (deliveryId) {
    claimToken = await claimEvent(input.db, deliveryId, input.ingress.provider, input.claimTtlSeconds);
    if (claimToken === null) {
      const claim = await readClaimState(input.db, deliveryId, input.ingress.provider);
      log.info(
        {
          provider: input.ingress.provider,
          deliveryId,
          claimState: claim?.state ?? null,
          ...(claim?.state === "pending" ? { claimExpiresAt: claim.expiresAt } : {}),
        },
        "duplicate SCM webhook delivery, skipping",
      );
      return { outcome: "duplicate", claimState: claim?.state ?? null };
    }
  }

  const markDone = async (): Promise<void> => {
    if (!deliveryId || claimToken === null) return;
    try {
      const completed = await completeEvent(input.db, deliveryId, input.ingress.provider, claimToken);
      if (!completed) {
        // The claim expired mid-handler and a redelivery took it over. The
        // side effects of this attempt already landed; the takeover attempt
        // duplicates them (bounded, at-least-once by design), so there is
        // nothing to roll back — just make the overlap observable.
        log.warn(
          { provider: input.ingress.provider, deliveryId },
          "webhook claim was taken over before completion; redelivery may duplicate side effects",
        );
      }
    } catch (err) {
      // Side effects are durably committed, so failing the request here
      // would make GitHub redeliver and duplicate them after the TTL. Keep
      // the success response and ring a bell instead: the row stays pending
      // until a redelivery takes it over or the hygiene sweep removes it.
      log.error(
        {
          err,
          metric: "webhook_claim_complete_failed_total",
          provider: input.ingress.provider,
          deliveryId,
        },
        "failed to mark processed webhook delivery done",
      );
    }
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
    if (!input.event) {
      await markDone();
      return { outcome: "provider_only", providerResult };
    }

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
      await markDone();
      return { outcome: "audience_empty", reason, providerResult };
    }

    const deliveryStats = await input.deliver(input.event, audience);
    await markDone();
    return { outcome: "delivered", deliveryStats, providerResult };
  } catch (err) {
    if (deliveryId && claimToken !== null) {
      await releaseClaimedEvent(input.db, deliveryId, input.ingress.provider, claimToken).catch((releaseErr) => {
        // Release is best-effort: if it fails the claim simply stays pending
        // until its TTL expires, after which a redelivery takes it over.
        log.error(
          { err: releaseErr, provider: input.ingress.provider, deliveryId },
          "failed to release claimed SCM webhook delivery after handler error",
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
