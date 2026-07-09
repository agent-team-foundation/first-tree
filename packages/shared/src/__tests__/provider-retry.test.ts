import { describe, expect, it } from "vitest";
import {
  encodeProviderRetryEventMessage,
  type ProviderRetryEventPayload,
  parseProviderRetryEventMessage,
  statusReasonFromProviderRetryEvent,
} from "../schemas/provider-retry.js";

function retryPayload(overrides: Partial<ProviderRetryEventPayload> = {}): ProviderRetryEventPayload {
  return {
    event: "provider_retry_scheduled",
    provider: "claude-code",
    scope: "provider_turn",
    category: "transient_transport",
    reasonCode: "network_reset",
    retryMode: "foreground",
    userSeverity: "warning",
    attempt: 1,
    maxAttempts: 3,
    messagePreview: "The provider connection reset.",
    ...overrides,
  };
}

describe("provider retry event messages", () => {
  it("round-trips valid retry event payloads", () => {
    const payload = retryPayload({ delayMs: 1000, nextRetryAt: "2026-07-09T00:00:00.000Z" });

    expect(parseProviderRetryEventMessage(encodeProviderRetryEventMessage(payload))).toEqual(payload);
  });

  it("returns null for non-retry, empty, malformed, and schema-invalid messages", () => {
    expect(parseProviderRetryEventMessage("plain provider failure")).toBeNull();
    expect(parseProviderRetryEventMessage("provider.retry:")).toBeNull();
    expect(parseProviderRetryEventMessage("provider.retry: {bad json")).toBeNull();
    expect(parseProviderRetryEventMessage("provider.retry: {}")).toBeNull();
  });

  it("builds retrying, waiting, and terminal status reasons", () => {
    expect(statusReasonFromProviderRetryEvent(retryPayload())).toMatchObject({
      kind: "retrying",
      label: "Retrying provider",
      detail: "The provider connection reset.",
    });
    expect(
      statusReasonFromProviderRetryEvent(
        retryPayload({
          retryMode: "background",
          category: "provider_capacity",
          reasonCode: "capacity_wait_required",
          nextRetryAt: "2026-07-09T00:05:00.000Z",
        }),
      ),
    ).toMatchObject({
      kind: "waiting",
      label: "Waiting for provider capacity",
    });
    expect(
      statusReasonFromProviderRetryEvent(
        retryPayload({
          retryMode: "background",
          category: "unknown",
          reasonCode: "will_retry_later",
        }),
      ),
    ).toMatchObject({
      kind: "waiting",
      label: "Waiting to retry provider",
    });
  });

  it("returns null for success and labels terminal failures", () => {
    expect(statusReasonFromProviderRetryEvent(retryPayload({ event: "provider_retry_succeeded" }))).toBeNull();
    expect(
      statusReasonFromProviderRetryEvent(
        retryPayload({
          event: "provider_retry_exhausted",
          category: "credential",
          reasonCode: "auth_failed",
          userSeverity: "error",
        }),
      ),
    ).toMatchObject({
      kind: "terminal",
      label: "Provider retry exhausted",
    });
    expect(
      statusReasonFromProviderRetryEvent(
        retryPayload({
          event: "provider_failure_terminal",
          category: "provider_capacity",
          reasonCode: "capacity_wait_required",
          userSeverity: "error",
        }),
      ),
    ).toMatchObject({
      kind: "terminal",
      label: "Provider capacity limit",
    });
    expect(
      statusReasonFromProviderRetryEvent(
        retryPayload({
          event: "provider_failure_terminal",
          category: "configuration",
          reasonCode: "bad_config",
          userSeverity: "error",
        }),
      ),
    ).toMatchObject({
      kind: "terminal",
      label: "Provider failure",
    });
  });
});
