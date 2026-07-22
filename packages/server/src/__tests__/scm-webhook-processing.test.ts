import type { NormalizedScmEvent, ScmIngressContext } from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { processedEvents } from "../db/schema/processed-events.js";
import * as eventDedupService from "../services/event-dedup.js";
import { processScmWebhookDelivery } from "../services/scm-webhook-processing.js";
import { useTestApp } from "./helpers.js";

const TTL_SECONDS = 300;

function makeIngress(stableDeliveryId: string | null): ScmIngressContext {
  return {
    provider: "github",
    source: { organizationId: "org-1", externalId: "installation:1" },
    stableDeliveryId,
    ingressAuthority: "verified_signature",
  };
}

function makeEvent(ingress: ScmIngressContext): NormalizedScmEvent {
  return {
    ...ingress,
    eventType: "issues",
    action: "opened",
    entity: {
      type: "issue",
      projectKey: "owner/repo",
      key: "owner/repo#1",
      title: "Issue",
      url: "https://github.com/owner/repo/issues/1",
    },
    actor: { externalUsername: "alice", isBot: false },
    kind: "opened",
    targets: [{ externalUsername: "bob", reason: "assigned" }],
    surface: { title: "Issue #1: Issue", body: "", url: "https://github.com/owner/repo/issues/1" },
    relatedRefs: [],
  };
}

describe("processScmWebhookDelivery", () => {
  const getApp = useTestApp();

  type App = ReturnType<typeof getApp>;

  async function getClaimRow(app: App, deliveryId: string) {
    const [row] = await app.db
      .select()
      .from(processedEvents)
      .where(and(eq(processedEvents.eventId, deliveryId), eq(processedEvents.platform, "github")));
    return row;
  }

  /** Rewind a pending claim's expiry into the past — the test-time stand-in
   * for "the claim TTL elapsed since the attempt died". */
  async function expireClaim(app: App, deliveryId: string) {
    await app.db
      .update(processedEvents)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(and(eq(processedEvents.eventId, deliveryId), eq(processedEvents.platform, "github")));
  }

  it("claims a stable delivery once, finishes it done, and skips the duplicate before provider work", async () => {
    const app = getApp();
    const ingress = makeIngress("delivery-stable");
    const event = makeEvent(ingress);
    const runProviderWork = vi.fn(async () => "provider-result");
    const resolveAudience = vi.fn(async () => ({ targets: ["target-1"], actorHumanId: null }));
    const deliver = vi.fn(async () => ({ delivered: 1, failed: 0 }));

    const first = await processScmWebhookDelivery({
      db: app.db,
      ingress,
      claimTtlSeconds: TTL_SECONDS,
      observation: null,
      event,
      applyObservation: async () => undefined,
      runProviderWork,
      resolveAudience,
      deliver,
    });
    const duplicate = await processScmWebhookDelivery({
      db: app.db,
      ingress,
      claimTtlSeconds: TTL_SECONDS,
      observation: null,
      event,
      applyObservation: async () => undefined,
      runProviderWork,
      resolveAudience,
      deliver,
    });

    expect(first).toEqual({
      outcome: "delivered",
      deliveryStats: { delivered: 1, failed: 0 },
      providerResult: "provider-result",
    });
    expect(duplicate).toEqual({ outcome: "duplicate", claimState: "done" });
    expect(runProviderWork).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledOnce();
    expect(await getClaimRow(app, "delivery-stable")).toMatchObject({
      status: "done",
      expiresAt: null,
      claimToken: null,
    });
  });

  it("does not claim without a stable delivery id, so repeated requests repeat side effects", async () => {
    const app = getApp();
    const ingress = makeIngress(null);
    const event = makeEvent(ingress);
    const deliver = vi.fn(async () => ({ delivered: 1, failed: 0 }));
    const input = {
      db: app.db,
      ingress,
      claimTtlSeconds: TTL_SECONDS,
      observation: null,
      event,
      applyObservation: async () => undefined,
      runProviderWork: async () => null,
      resolveAudience: async () => ({ targets: ["target-1"], actorHumanId: null }),
      deliver,
    };

    expect((await processScmWebhookDelivery(input)).outcome).toBe("delivered");
    expect((await processScmWebhookDelivery(input)).outcome).toBe("delivered");
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("applies an observation without resolving audience or delivering a card", async () => {
    const app = getApp();
    const ingress = makeIngress(null);
    const applyObservation = vi.fn(async () => undefined);
    const resolveAudience = vi.fn(async () => ({ targets: ["unexpected"], actorHumanId: null }));
    const deliver = vi.fn(async () => ({ delivered: 1 }));

    const result = await processScmWebhookDelivery({
      db: app.db,
      ingress,
      claimTtlSeconds: TTL_SECONDS,
      observation: {
        entity: {
          type: "pull_request",
          projectKey: "owner/repo",
          key: "owner/repo#2",
          title: "Silent lifecycle update",
        },
        state: "merged",
        observedAt: new Date().toISOString(),
      },
      event: null,
      applyObservation,
      runProviderWork: async () => "provider-result",
      resolveAudience,
      deliver,
    });

    expect(result).toEqual({ outcome: "provider_only", providerResult: "provider-result" });
    expect(applyObservation).toHaveBeenCalledOnce();
    expect(resolveAudience).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("marks a provider_only stable delivery done", async () => {
    const app = getApp();
    const ingress = makeIngress("delivery-provider-only");

    const result = await processScmWebhookDelivery({
      db: app.db,
      ingress,
      claimTtlSeconds: TTL_SECONDS,
      observation: null,
      event: null,
      applyObservation: async () => undefined,
      runProviderWork: async () => "provider-result",
      resolveAudience: async () => ({ targets: [], actorHumanId: null }),
      deliver: async () => ({ delivered: 0 }),
    });

    expect(result).toEqual({ outcome: "provider_only", providerResult: "provider-result" });
    expect(await getClaimRow(app, "delivery-provider-only")).toMatchObject({ status: "done" });
  });

  it("does not suppress semantic delivery when projection refresh fails", async () => {
    const app = getApp();
    const ingress = makeIngress(null);
    const event = makeEvent(ingress);
    const deliver = vi.fn(async () => ({ delivered: 1 }));

    await expect(
      processScmWebhookDelivery({
        db: app.db,
        ingress,
        claimTtlSeconds: TTL_SECONDS,
        observation: {
          entity: event.entity,
          state: "open",
          observedAt: new Date().toISOString(),
        },
        event,
        applyObservation: async () => {
          throw new Error("projection unavailable");
        },
        runProviderWork: async () => null,
        resolveAudience: async () => ({ targets: ["target-1"], actorHumanId: null }),
        deliver,
      }),
    ).resolves.toMatchObject({ outcome: "delivered" });
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("releases a stable delivery after an uncaught failure so a redelivery reprocesses immediately", async () => {
    const app = getApp();
    const ingress = makeIngress("delivery-retryable");
    const event = makeEvent(ingress);

    await expect(
      processScmWebhookDelivery({
        db: app.db,
        ingress,
        claimTtlSeconds: TTL_SECONDS,
        observation: null,
        event,
        applyObservation: async () => undefined,
        runProviderWork: async () => null,
        resolveAudience: async () => {
          throw new Error("audience unavailable");
        },
        deliver: async () => ({ delivered: 0 }),
      }),
    ).rejects.toThrow("audience unavailable");

    // Release fast-expires the pending row instead of deleting it, so the
    // next redelivery takes the claim over inline.
    const released = await getClaimRow(app, "delivery-retryable");
    expect(released?.status).toBe("pending");
    expect(released?.expiresAt?.getTime()).toBeLessThanOrEqual(Date.now());

    const retried = await processScmWebhookDelivery({
      db: app.db,
      ingress,
      claimTtlSeconds: TTL_SECONDS,
      observation: null,
      event,
      applyObservation: async () => undefined,
      runProviderWork: async () => null,
      resolveAudience: async () => ({ targets: ["target-1"], actorHumanId: null }),
      deliver: async () => ({ delivered: 1 }),
    });
    expect(retried.outcome).toBe("delivered");
    expect(await getClaimRow(app, "delivery-retryable")).toMatchObject({ status: "done" });
  });

  it("returns duplicate with claimState pending while an unexpired claim shields a crashed attempt", async () => {
    // Crash equivalent A: the previous attempt committed its claim and died
    // mid-processing; its TTL has not elapsed yet, so a redelivery inside
    // the protection window is deduped (this also shields live handlers).
    const app = getApp();
    const ingress = makeIngress("delivery-crash-window");
    const event = makeEvent(ingress);
    const preClaim = await eventDedupService.claimEvent(app.db, "delivery-crash-window", "github", TTL_SECONDS);
    expect(preClaim).not.toBeNull();
    const runProviderWork = vi.fn(async () => null);

    const result = await processScmWebhookDelivery({
      db: app.db,
      ingress,
      claimTtlSeconds: TTL_SECONDS,
      observation: null,
      event,
      applyObservation: async () => undefined,
      runProviderWork,
      resolveAudience: async () => ({ targets: ["target-1"], actorHumanId: null }),
      deliver: async () => ({ delivered: 1 }),
    });

    expect(result).toEqual({ outcome: "duplicate", claimState: "pending" });
    expect(runProviderWork).not.toHaveBeenCalled();
  });

  it("takes over an expired pending claim and fully reprocesses the delivery", async () => {
    // Crash equivalent B (the issue's core scenario): the previous attempt
    // claimed and died; after the TTL a redelivery must take the claim over
    // and run the whole pipeline exactly once instead of losing the event.
    const app = getApp();
    const ingress = makeIngress("delivery-crash-recovery");
    const event = makeEvent(ingress);
    const preClaim = await eventDedupService.claimEvent(app.db, "delivery-crash-recovery", "github", TTL_SECONDS);
    expect(preClaim).not.toBeNull();
    await expireClaim(app, "delivery-crash-recovery");
    const runProviderWork = vi.fn(async () => "provider-result");
    const deliver = vi.fn(async () => ({ delivered: 1, failed: 0 }));

    const result = await processScmWebhookDelivery({
      db: app.db,
      ingress,
      claimTtlSeconds: TTL_SECONDS,
      observation: null,
      event,
      applyObservation: async () => undefined,
      runProviderWork,
      resolveAudience: async () => ({ targets: ["target-1"], actorHumanId: null }),
      deliver,
    });

    expect(result).toMatchObject({ outcome: "delivered" });
    expect(runProviderWork).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledOnce();
    expect(await getClaimRow(app, "delivery-crash-recovery")).toMatchObject({
      status: "done",
      expiresAt: null,
      claimToken: null,
    });
  });

  it("stays recoverable when the release itself fails (leak path 2)", async () => {
    const app = getApp();
    const ingress = makeIngress("delivery-release-down");
    const event = makeEvent(ingress);
    const releaseSpy = vi
      .spyOn(eventDedupService, "releaseClaimedEvent")
      .mockRejectedValueOnce(new Error("release down"));

    try {
      await expect(
        processScmWebhookDelivery({
          db: app.db,
          ingress,
          claimTtlSeconds: TTL_SECONDS,
          observation: null,
          event,
          applyObservation: async () => undefined,
          runProviderWork: async () => null,
          resolveAudience: async () => {
            throw new Error("audience unavailable");
          },
          deliver: async () => ({ delivered: 0 }),
        }),
      ).rejects.toThrow("audience unavailable");
      expect(releaseSpy).toHaveBeenCalledOnce();
    } finally {
      releaseSpy.mockRestore();
    }

    // The claim row survived the failed release with its original TTL…
    const stuck = await getClaimRow(app, "delivery-release-down");
    expect(stuck?.status).toBe("pending");
    expect(stuck?.expiresAt?.getTime()).toBeGreaterThan(Date.now());

    // …so once the TTL elapses, a redelivery recovers the event (before
    // this fix the row was permanent and the delivery was lost forever).
    await expireClaim(app, "delivery-release-down");
    const retried = await processScmWebhookDelivery({
      db: app.db,
      ingress,
      claimTtlSeconds: TTL_SECONDS,
      observation: null,
      event,
      applyObservation: async () => undefined,
      runProviderWork: async () => null,
      resolveAudience: async () => ({ targets: ["target-1"], actorHumanId: null }),
      deliver: async () => ({ delivered: 1 }),
    });
    expect(retried.outcome).toBe("delivered");
    expect(await getClaimRow(app, "delivery-release-down")).toMatchObject({ status: "done" });
  });

  it("returns the success outcome when completeEvent fails, leaving the row pending", async () => {
    const app = getApp();
    const ingress = makeIngress("delivery-complete-down");
    const event = makeEvent(ingress);
    const completeSpy = vi.spyOn(eventDedupService, "completeEvent").mockRejectedValueOnce(new Error("complete down"));

    try {
      const result = await processScmWebhookDelivery({
        db: app.db,
        ingress,
        claimTtlSeconds: TTL_SECONDS,
        observation: null,
        event,
        applyObservation: async () => undefined,
        runProviderWork: async () => null,
        resolveAudience: async () => ({ targets: ["target-1"], actorHumanId: null }),
        deliver: async () => ({ delivered: 1, failed: 0 }),
      });

      // Side effects landed; failing the request would provoke a redelivery
      // and a guaranteed duplicate, so the outcome stays a success.
      expect(result).toMatchObject({ outcome: "delivered" });
      expect(completeSpy).toHaveBeenCalledOnce();
    } finally {
      completeSpy.mockRestore();
    }
    expect((await getClaimRow(app, "delivery-complete-down"))?.status).toBe("pending");
  });

  it("processes exactly one of two concurrent deliveries with the same id", async () => {
    const app = getApp();
    const ingress = makeIngress("delivery-concurrent");
    const event = makeEvent(ingress);
    const runProviderWork = vi.fn(async () => null);
    const deliver = vi.fn(async () => ({ delivered: 1, failed: 0 }));
    const input = {
      db: app.db,
      ingress,
      claimTtlSeconds: TTL_SECONDS,
      observation: null,
      event,
      applyObservation: async () => undefined,
      runProviderWork,
      resolveAudience: async () => ({ targets: ["target-1"], actorHumanId: null }),
      deliver,
    };

    const [a, b] = await Promise.all([processScmWebhookDelivery(input), processScmWebhookDelivery(input)]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["delivered", "duplicate"]);
    expect(runProviderWork).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("keeps the whole-request claim when provider delivery isolates a per-chat failure", async () => {
    const app = getApp();
    const ingress = makeIngress("delivery-partial");
    const event = makeEvent(ingress);
    const input = {
      db: app.db,
      ingress,
      claimTtlSeconds: TTL_SECONDS,
      observation: null,
      event,
      applyObservation: async () => undefined,
      runProviderWork: async () => null,
      resolveAudience: async () => ({ targets: ["chat-a", "chat-b"], actorHumanId: null }),
      deliver: async () => ({ delivered: 1, failed: 1 }),
    };

    const first = await processScmWebhookDelivery(input);
    const duplicate = await processScmWebhookDelivery(input);

    expect(first).toMatchObject({ outcome: "delivered", deliveryStats: { delivered: 1, failed: 1 } });
    expect(duplicate).toEqual({ outcome: "duplicate", claimState: "done" });
  });

  it("rejects a normalized event whose provider-neutral ingress facts drift", async () => {
    const app = getApp();
    const ingress = makeIngress("delivery-mismatch");
    const event = makeEvent({ ...ingress, source: { ...ingress.source, organizationId: "other-org" } });

    await expect(
      processScmWebhookDelivery({
        db: app.db,
        ingress,
        claimTtlSeconds: TTL_SECONDS,
        observation: null,
        event,
        applyObservation: async () => undefined,
        runProviderWork: async () => null,
        resolveAudience: async () => ({ targets: [], actorHumanId: null }),
        deliver: async () => ({ delivered: 0 }),
      }),
    ).rejects.toThrow("normalized SCM event does not match its ingress context");
  });

  it("sweepExpiredWebhookClaims deletes only pending rows expired past the grace period", async () => {
    const app = getApp();

    // Pending, expired far beyond the 24h grace — the only sweep target.
    const staleToken = await eventDedupService.claimEvent(app.db, "sweep-stale", "github", TTL_SECONDS);
    expect(staleToken).not.toBeNull();
    await app.db
      .update(processedEvents)
      .set({ expiresAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(and(eq(processedEvents.eventId, "sweep-stale"), eq(processedEvents.platform, "github")));

    // Pending, expired but still inside the grace period.
    const recentToken = await eventDedupService.claimEvent(app.db, "sweep-recent", "github", TTL_SECONDS);
    expect(recentToken).not.toBeNull();
    await expireClaim(app, "sweep-recent");

    // Fresh pending claim.
    expect(await eventDedupService.claimEvent(app.db, "sweep-fresh", "github", TTL_SECONDS)).not.toBeNull();

    // Done row — never swept.
    const doneToken = await eventDedupService.claimEvent(app.db, "sweep-done", "github", TTL_SECONDS);
    if (doneToken === null) throw new Error("expected claim to win");
    await eventDedupService.completeEvent(app.db, "sweep-done", "github", doneToken);

    const swept = await eventDedupService.sweepExpiredWebhookClaims(app.db);

    expect(swept).toBe(1);
    expect(await getClaimRow(app, "sweep-stale")).toBeUndefined();
    expect(await getClaimRow(app, "sweep-recent")).toMatchObject({ status: "pending" });
    expect(await getClaimRow(app, "sweep-fresh")).toMatchObject({ status: "pending" });
    expect(await getClaimRow(app, "sweep-done")).toMatchObject({ status: "done" });
  });
});
