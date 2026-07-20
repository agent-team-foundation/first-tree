import type { NormalizedScmEvent, ScmIngressContext } from "@first-tree/shared";
import { describe, expect, it, vi } from "vitest";
import { processScmWebhookDelivery } from "../services/scm-webhook-processing.js";
import { useTestApp } from "./helpers.js";

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

  it("claims a stable delivery once and skips the duplicate before provider work", async () => {
    const app = getApp();
    const ingress = makeIngress("delivery-stable");
    const event = makeEvent(ingress);
    const runProviderWork = vi.fn(async () => "provider-result");
    const resolveAudience = vi.fn(async () => ({ targets: ["target-1"], actorHumanId: null }));
    const deliver = vi.fn(async () => ({ delivered: 1, failed: 0 }));

    const first = await processScmWebhookDelivery({
      db: app.db,
      ingress,
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
    expect(duplicate).toEqual({ outcome: "duplicate" });
    expect(runProviderWork).toHaveBeenCalledOnce();
    expect(resolveAudience).toHaveBeenCalledWith(event, "provider-result");
    expect(deliver).toHaveBeenCalledWith(event, { targets: ["target-1"], actorHumanId: null }, "provider-result");
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("does not claim without a stable delivery id, so repeated requests repeat side effects", async () => {
    const app = getApp();
    const ingress = makeIngress(null);
    const event = makeEvent(ingress);
    const deliver = vi.fn(async () => ({ delivered: 1, failed: 0 }));
    const input = {
      db: app.db,
      ingress,
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

  it("does not suppress semantic delivery when projection refresh fails", async () => {
    const app = getApp();
    const ingress = makeIngress(null);
    const event = makeEvent(ingress);
    const deliver = vi.fn(async () => ({ delivered: 1 }));

    await expect(
      processScmWebhookDelivery({
        db: app.db,
        ingress,
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

  it("best-effort unclaims a stable delivery after an uncaught top-level failure", async () => {
    const app = getApp();
    const ingress = makeIngress("delivery-retryable");
    const event = makeEvent(ingress);

    await expect(
      processScmWebhookDelivery({
        db: app.db,
        ingress,
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

    const retried = await processScmWebhookDelivery({
      db: app.db,
      ingress,
      observation: null,
      event,
      applyObservation: async () => undefined,
      runProviderWork: async () => null,
      resolveAudience: async () => ({ targets: ["target-1"], actorHumanId: null }),
      deliver: async () => ({ delivered: 1 }),
    });
    expect(retried.outcome).toBe("delivered");
  });

  it("keeps the whole-request claim when provider delivery isolates a per-chat failure", async () => {
    const app = getApp();
    const ingress = makeIngress("delivery-partial");
    const event = makeEvent(ingress);
    const input = {
      db: app.db,
      ingress,
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
    expect(duplicate).toEqual({ outcome: "duplicate" });
  });

  it("rejects a normalized event whose provider-neutral ingress facts drift", async () => {
    const app = getApp();
    const ingress = makeIngress("delivery-mismatch");
    const event = makeEvent({ ...ingress, source: { ...ingress.source, organizationId: "other-org" } });

    await expect(
      processScmWebhookDelivery({
        db: app.db,
        ingress,
        observation: null,
        event,
        applyObservation: async () => undefined,
        runProviderWork: async () => null,
        resolveAudience: async () => ({ targets: [], actorHumanId: null }),
        deliver: async () => ({ delivered: 0 }),
      }),
    ).rejects.toThrow("normalized SCM event does not match its ingress context");
  });
});
