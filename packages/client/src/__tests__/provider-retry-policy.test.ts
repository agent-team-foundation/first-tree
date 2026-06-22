import type { ProviderRetryScope, ReplaySafety, RuntimeProvider } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import {
  buildProviderRetryEvent,
  classifyProviderFailure,
  decideProviderRetry,
  type ProviderFailureClassification,
} from "../runtime/provider-retry-policy.js";

class FakeRateLimit extends Error {
  override name = "RateLimitError";
  status = 429;
}

function classification(category: ProviderFailureClassification["category"], reasonCode: string = category) {
  return {
    category,
    reasonCode,
    message: reasonCode,
    sourceKind: "transient",
  } satisfies ProviderFailureClassification;
}

function decide(input: {
  category: ProviderFailureClassification["category"];
  scope?: ProviderRetryScope;
  attempt?: number;
  retryAfterMs?: number;
  replaySafety?: ReplaySafety;
  reasonCode?: string;
}) {
  return decideProviderRetry({
    classification: classification(input.category, input.reasonCode),
    scope: input.scope ?? "provider_turn",
    attempt: input.attempt ?? 1,
    retryAfterMs: input.retryAfterMs,
    replaySafety: input.replaySafety ?? "pre_visible",
  });
}

describe("classifyProviderFailure", () => {
  it("maps provider rate limits to provider_capacity", () => {
    expect(
      classifyProviderFailure(new FakeRateLimit("rate limited"), {
        provider: "claude-code",
        scope: "provider_turn",
        source: "stream",
      }),
    ).toMatchObject({ category: "provider_capacity", reasonCode: "provider_rate_limited" });
  });

  it("maps network and 5xx failures to transient_transport", () => {
    for (const err of [new Error("fetch failed"), Object.assign(new Error("upstream 503"), { status: 503 })]) {
      expect(classifyProviderFailure(err, { provider: "codex", scope: "provider_turn", source: "sdk" }).category).toBe(
        "transient_transport",
      );
    }
  });

  it("maps deterministic and operator-actionable failures to stop categories", () => {
    const cases: Array<[unknown, ProviderFailureClassification["category"]]> = [
      [Object.assign(new Error("401 Unauthorized"), { status: 401 }), "credential"],
      [Object.assign(new Error("request failed"), { status: 401 }), "credential"],
      [Object.assign(new Error("request failed"), { statusCode: 403 }), "credential"],
      [new Error("Codex runtime binary is missing"), "capability"],
      [new Error("sandbox approval rejected"), "configuration"],
      [new Error("context length exceeded"), "deterministic_input"],
    ];
    for (const [err, category] of cases) {
      expect(classifyProviderFailure(err, { provider: "codex", scope: "provider_turn", source: "sdk" }).category).toBe(
        category,
      );
    }
  });
});

describe("decideProviderRetry", () => {
  it("keeps provider_turn retry budget finite and foreground-only", () => {
    expect(decide({ category: "transient_transport", attempt: 1 })).toMatchObject({
      action: "retry",
      delayMs: 500,
      retryMode: "foreground",
      maxAttempts: 2,
    });
    expect(decide({ category: "transient_transport", attempt: 2 })).toMatchObject({
      action: "retry",
      delayMs: 1500,
    });
    expect(decide({ category: "transient_transport", attempt: 3 })).toMatchObject({
      action: "stop",
      terminalKind: "exhausted",
    });
  });

  it("does not apply provider_turn budget to session_start/session_resume transient failures", () => {
    for (const scope of ["session_start", "session_resume"] as const) {
      expect(decide({ category: "transient_transport", scope, attempt: 20 })).toMatchObject({
        action: "retry",
        retryMode: "background",
      });
    }
  });

  it("stops unknown after a small budget in every scope", () => {
    expect(decide({ category: "unknown", scope: "provider_turn", attempt: 2 })).toMatchObject({
      action: "retry",
      delayMs: 15000,
    });
    expect(decide({ category: "unknown", scope: "session_resume", attempt: 3 })).toMatchObject({
      action: "stop",
      reasonCode: "unknown_exhausted",
      terminalKind: "exhausted",
    });
  });

  it("does not return capacity_wait_required for pre_provider failures", () => {
    expect(
      decide({
        category: "provider_capacity",
        reasonCode: "provider_rate_limited",
        replaySafety: "pre_provider",
        attempt: 3,
        retryAfterMs: 120_000,
      }),
    ).toMatchObject({ action: "stop", terminalKind: "exhausted" });
  });

  it("returns capacity_wait_required for provider-entered long capacity refusals", () => {
    expect(
      decide({
        category: "provider_capacity",
        reasonCode: "provider_rate_limited",
        replaySafety: "provider_entered",
        retryAfterMs: 120_000,
      }),
    ).toMatchObject({
      action: "stop",
      reasonCode: "capacity_wait_required",
      terminalKind: "capacity_wait_required",
    });
  });

  it("stops unsafe provider_turn replay before retrying", () => {
    expect(
      decide({
        category: "transient_transport",
        replaySafety: "user_visible",
        attempt: 1,
      }),
    ).toMatchObject({ action: "stop", terminalKind: "unsafe_replay" });
    expect(
      decide({
        category: "transient_transport",
        replaySafety: "unknown",
        attempt: 1,
      }),
    ).toMatchObject({ action: "stop", terminalKind: "unsafe_replay" });
  });
});

describe("buildProviderRetryEvent", () => {
  it("builds standard payloads from decisions", () => {
    const provider: RuntimeProvider = "codex";
    const c = classification("transient_transport", "network_error");
    const decision = decideProviderRetry({
      classification: c,
      scope: "provider_turn",
      attempt: 1,
      replaySafety: "pre_visible",
    });
    expect(
      buildProviderRetryEvent({
        event: "provider_retry_scheduled",
        provider,
        scope: "provider_turn",
        classification: c,
        decision,
        messagePreview: "fetch failed with token ghp_secret_should_be_redacted",
        now: 1_000,
      }),
    ).toMatchObject({
      event: "provider_retry_scheduled",
      provider,
      scope: "provider_turn",
      category: "transient_transport",
      reasonCode: "network_error",
      attempt: 1,
      maxAttempts: 2,
      delayMs: 500,
      userSeverity: "info",
    });
  });
});
