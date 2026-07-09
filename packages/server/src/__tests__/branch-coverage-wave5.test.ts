import { afterEach, describe, expect, it, vi } from "vitest";
import { setErrorSink } from "../observability/logger.js";
import {
  currentSpanId,
  currentTraceId,
  installPinoErrorBridge,
  reportError,
  uninstallPinoErrorBridge,
} from "../observability/otel-helpers.js";
import { getAgentWithRuntime, listAgentsWithRuntime, upsertSessionState } from "../services/activity.js";
import { createAttachment, loadAttachmentData } from "../services/attachment.js";
import { clientStatusForApi, extractCapabilities, extractLastUpdateAttempt, getClient } from "../services/client.js";
import {
  githubEntityDedupKey,
  githubEntityKeyCandidates,
  legacyDiscussionEntityKey,
} from "../services/github-entity-key.js";
import { assertNoLandingCampaignTrialAgents, assertTrialQuota } from "../services/landing-campaigns/guards.js";
import {
  buildLandingCampaignChatMetadata,
  isLandingCampaignTrialAgent,
  withLandingCampaignChatState,
} from "../services/landing-campaigns/metadata.js";
import { notifyAgentEvent } from "../services/notification.js";
import { createPulseAggregator } from "../services/pulse-aggregator.js";

function queryChain(rows: unknown[] = []): unknown {
  const promise = Promise.resolve(rows);
  const chain = new Proxy(
    function queryProxy(): unknown {
      return chain;
    },
    {
      get: (_target, prop) => {
        if (prop === "then") return promise.then.bind(promise);
        if (prop === "catch") return promise.catch.bind(promise);
        if (prop === "finally") return promise.finally.bind(promise);
        if (prop === Symbol.iterator) return rows[Symbol.iterator].bind(rows);
        if (prop === "returning") return vi.fn(async () => rows);
        if (prop === "for") return vi.fn(() => chain);
        if (prop === "onConflictDoUpdate") return vi.fn(() => chain);
        return vi.fn(() => chain);
      },
      apply: () => chain,
    },
  );
  return chain;
}

describe("branch coverage wave5 — pure helpers", () => {
  it("covers client extractors and status mapping", () => {
    expect(extractLastUpdateAttempt(null)).toBeNull();
    expect(extractLastUpdateAttempt("x")).toBeNull();
    expect(extractLastUpdateAttempt({})).toBeNull();
    expect(extractLastUpdateAttempt({ lastUpdateAttempt: { bad: true } })).toBeNull();
    expect(extractCapabilities(null)).toEqual({});
    expect(extractCapabilities("x")).toEqual({});
    expect(
      extractCapabilities({
        capabilities: {
          codex: { available: true, state: "ok", detectedAt: "2026-01-01T00:00:00.000Z" },
        },
      }),
    ).toMatchObject({
      codex: { available: true },
    });
    expect(extractCapabilities({ capabilities: "nope" })).toEqual({});

    expect(clientStatusForApi({ status: "connected", retiredAt: new Date() })).toBe("retired");
    expect(clientStatusForApi({ status: "connected", retiredAt: null })).toBe("connected");
    expect(clientStatusForApi({ status: "disconnected" })).toBe("disconnected");
    expect(clientStatusForApi({ status: "weird" })).toBe("disconnected");
  });

  it("covers github entity key candidates without defensive dead branches", () => {
    expect(legacyDiscussionEntityKey("not-a-key")).toBeNull();
    expect(legacyDiscussionEntityKey("o/r#9")).toBe("o/r#discussion-9");
    expect(githubEntityKeyCandidates("discussion", "o/r#discussion-3")).toEqual(["o/r#discussion-3", "o/r#3"]);
    expect(githubEntityDedupKey("issue", "o/r#1")).toBe("issue::o/r#1");
  });

  it("covers landing campaign metadata fallbacks", () => {
    expect(isLandingCampaignTrialAgent(null)).toBe(false);
    expect(isLandingCampaignTrialAgent({ metadata: null })).toBe(false);
    expect(isLandingCampaignTrialAgent({ metadata: { landingCampaignTrial: true, campaign: "x" } })).toBe(false);

    const base = buildLandingCampaignChatMetadata({
      campaign: "portfolio",
      agentId: "a1",
      skillSetId: "portfolio",
      skillSetVersion: "v1",
      repo: {
        url: "https://github.com/a/b",
        canonicalKey: "github.com/a/b",
        owner: "a",
        name: "b",
      },
      state: "running",
      inputLocked: false,
      maxAgentTurns: 3,
    });
    // withLandingCampaignChatState on non-trial metadata is a no-op return
    expect(withLandingCampaignChatState({ plain: true }, "completed", true)).toEqual({ plain: true });
    expect(withLandingCampaignChatState(base, "completed", true, { limitReason: "turns" })).toMatchObject({
      landingCampaignTrial: expect.objectContaining({ state: "completed", limitReason: "turns" }),
    });
  });
});

describe("branch coverage wave5 — service fakes", () => {
  it("covers getClient null and attachment validation", async () => {
    await expect(getClient(queryChain([]) as never, "c1")).resolves.toBeNull();
    await expect(getClient(queryChain([{ id: "c1" }]) as never, "c1")).resolves.toEqual({ id: "c1" });

    await expect(
      createAttachment(queryChain([]) as never, {
        uploadedBy: "a",
        mimeType: "   ",
        filename: "x.png",
        data: Buffer.from("x"),
      }),
    ).rejects.toThrow("mime type is required");

    await expect(loadAttachmentData(queryChain([]) as never, "att")).resolves.toBeNull();
    await expect(loadAttachmentData(queryChain([{ data: Buffer.from("hi") }]) as never, "att")).resolves.toEqual(
      Buffer.from("hi"),
    );
  });

  it("covers activity list without scope", async () => {
    await expect(listAgentsWithRuntime(queryChain([]) as never)).resolves.toEqual([]);
    await expect(getAgentWithRuntime(queryChain([]) as never, "a")).resolves.toBeNull();

    // no-op same-state upsert: insert returning empty skips presence refresh
    const db = {
      transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
        const tx = {
          select: vi.fn(() => queryChain([])),
          insert: vi.fn(() => queryChain([])),
          update: vi.fn(() => queryChain([])),
        };
        return fn(tx);
      }),
    };
    await expect(upsertSessionState(db as never, "a", "c", "active", "org")).resolves.toBeUndefined();
  });

  it("covers notifyAgentEvent missing agent and hostname fallbacks", async () => {
    await expect(notifyAgentEvent(queryChain([]) as never, "missing", "agent_error", "high")).resolves.toBeUndefined();

    // agent with clientId but no client row → clientLabel falls back to clientId
    let selectCalls = 0;
    const db = {
      select: vi.fn(() => {
        selectCalls += 1;
        if (selectCalls === 1) {
          return queryChain([
            {
              organizationId: "org",
              name: "bot",
              displayName: null,
              clientId: "client_1",
            },
          ]);
        }
        if (selectCalls === 2) return queryChain([]); // no client row
        return queryChain([]);
      }),
      insert: vi.fn(() => queryChain([{ id: "n1" }])),
      update: vi.fn(() => queryChain([])),
    };
    await expect(notifyAgentEvent(db as never, "agent_1", "agent_blocked", "medium")).resolves.toBeUndefined();

    // agent without displayName or name uses agentId
    selectCalls = 0;
    const db2 = {
      select: vi.fn(() => {
        selectCalls += 1;
        if (selectCalls === 1) {
          return queryChain([
            {
              organizationId: "org",
              name: null,
              displayName: null,
              clientId: null,
            },
          ]);
        }
        return queryChain([]);
      }),
      insert: vi.fn(() => queryChain([{ id: "n2" }])),
      update: vi.fn(() => queryChain([])),
    };
    await expect(notifyAgentEvent(db2 as never, "agent_x", "agent_stale", "low")).resolves.toBeUndefined();
  });

  it("covers landing campaign empty agent list and quota under limit", async () => {
    await expect(assertNoLandingCampaignTrialAgents(queryChain([]) as never, [])).resolves.toBeUndefined();
    await expect(assertNoLandingCampaignTrialAgents(queryChain([[]]) as never, ["a1"])).resolves.toBeUndefined();

    await expect(
      assertTrialQuota(
        {
          select: vi.fn(() => queryChain([{ count: 0 }])),
        } as never,
        { growth: { landingCampaignMaxTrialsPerUserPer24Hours: 5 } } as never,
        "user_1",
      ),
    ).resolves.toBeUndefined();

    await expect(
      assertTrialQuota(
        {
          select: vi.fn(() => queryChain([{ count: 5 }])),
        } as never,
        { growth: { landingCampaignMaxTrialsPerUserPer24Hours: 5 } } as never,
        "user_1",
      ),
    ).rejects.toThrow("free trial limit");

    await expect(
      assertTrialQuota(
        {
          select: vi.fn(() => queryChain([])),
        } as never,
        { growth: { landingCampaignMaxTrialsPerUserPer24Hours: 1 } } as never,
        "user_1",
      ),
    ).resolves.toBeUndefined(); // usage?.count ?? 0
  });
});

describe("branch coverage wave5 — pulse + otel", () => {
  afterEach(() => {
    uninstallPinoErrorBridge();
    setErrorSink(null);
    vi.restoreAllMocks();
  });

  it("covers pulse aggregator skip and idle paths", () => {
    const broadcast = vi.fn();
    const onRuntimeStateChange = vi.fn();
    const agg = createPulseAggregator({
      notifier: { onRuntimeStateChange } as never,
      broadcast,
      intervalMs: 20,
      bucketCount: 4,
    });
    // ingest while not running is ignored
    agg.ingest({ organizationId: "o", agentId: "a", state: "working" });
    agg.start();
    agg.start(); // already running
    agg.ingest({ organizationId: "", agentId: "a", state: "working" });
    agg.ingest({ organizationId: "o", agentId: "", state: "working" });
    agg.ingest({ organizationId: "o", agentId: "a", state: "working" });
    agg.ingest({ organizationId: "o", agentId: "a", state: "error" });
    agg.stop();
    agg.stop(); // already stopped
    expect(onRuntimeStateChange).toHaveBeenCalled();
  });

  it("covers reportError err coercion branches with active span mock", async () => {
    const recordException = vi.fn();
    const setStatus = vi.fn();
    const setAttributes = vi.fn();
    const span = {
      recordException,
      setStatus,
      setAttributes,
      spanContext: () => ({
        traceId: "11111111111111111111111111111111",
        spanId: "2222222222222222",
        traceFlags: 1,
      }),
    };

    const otel = await import("@opentelemetry/api");
    const getActiveSpan = vi.spyOn(otel.trace, "getActiveSpan").mockReturnValue(span as never);

    reportError("msg", undefined, { k: 1 });
    reportError("msg", "string-err");
    reportError("msg", new Error("e"));
    expect(recordException).toHaveBeenCalled();

    installPinoErrorBridge();
    // trigger sink via setErrorSink path already installed
    const { applyLoggerConfig, createLogger } = await import("../observability/logger.js");
    applyLoggerConfig({ level: "error", format: "json", bridgeToSpanLevel: "error" });
    createLogger("wave5").error({ msg: "x" });

    expect(currentTraceId()).toBe("11111111111111111111111111111111");
    expect(currentSpanId()).toBe("2222222222222222");

    // zero ids
    getActiveSpan.mockReturnValue({
      ...span,
      spanContext: () => ({
        traceId: "00000000000000000000000000000000",
        spanId: "0000000000000000",
        traceFlags: 0,
      }),
    } as never);
    expect(currentTraceId()).toBeUndefined();
    expect(currentSpanId()).toBeUndefined();

    getActiveSpan.mockReturnValue(undefined as never);
    reportError("no-span", new Error("x"));
    expect(currentTraceId()).toBeUndefined();

    getActiveSpan.mockRestore();
  });
});
