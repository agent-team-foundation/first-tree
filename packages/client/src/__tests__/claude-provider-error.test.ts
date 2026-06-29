import { describe, expect, it } from "vitest";
import {
  claudeFailureFromAssistantMessage,
  claudeFailureFromSdkResult,
  formatClaudeProviderFailureNotice,
} from "../handlers/claude-provider-error.js";
import { classifyProviderFailure } from "../runtime/provider-retry-policy.js";

function classify(error: unknown) {
  return classifyProviderFailure(error, {
    provider: "claude-code",
    scope: "provider_turn",
    source: "sdk",
  });
}

describe("claude provider error adapter", () => {
  it("treats SDK success result with is_error as provider failure using structured status", () => {
    const failure = claudeFailureFromSdkResult({
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 403,
      result: "Failed to authenticate. API Error: 403 Insufficient account balance.",
    });

    expect(failure).not.toBeNull();
    if (!failure) throw new Error("expected failure");
    expect(failure.messagePreview).toBe("Failed to authenticate. API Error: 403 Insufficient account balance.");
    expect(classify(failure.signal.error)).toMatchObject({
      category: "provider_capacity",
      reasonCode: "provider_billing_limit",
    });
  });

  it("does not inspect ordinary success result text", () => {
    expect(
      claudeFailureFromSdkResult({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Here is how to handle API Error: 403 in your app.",
      }),
    ).toBeNull();
  });

  it("maps non-success result subtype and errors into a provider failure", () => {
    const failure = claudeFailureFromSdkResult({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["authentication_failed"],
    });

    expect(failure).not.toBeNull();
    if (!failure) throw new Error("expected failure");
    expect(classify(failure.signal.error)).toMatchObject({ category: "credential" });
  });

  it("maps assistant typed errors through provider retry classification", () => {
    const cases = [
      ["authentication_failed", "credential", "provider_credential_required"],
      ["billing_error", "provider_capacity", "provider_billing_limit"],
      ["rate_limit", "provider_capacity", "provider_rate_limited"],
      ["overloaded", "provider_capacity", "provider_overloaded"],
      ["invalid_request", "deterministic_input", "provider_deterministic_input"],
      ["model_not_found", "configuration", "provider_configuration_error"],
      ["server_error", "transient_transport", "claude_server_error"],
    ] as const;

    for (const [code, category, reasonCode] of cases) {
      const failure = claudeFailureFromAssistantMessage({ type: "assistant", error: code });
      expect(failure, code).not.toBeNull();
      if (!failure) throw new Error(`expected failure for ${code}`);
      expect(classify(failure.signal.error), code).toMatchObject({ category, reasonCode });
    }
  });

  it("formats a chat-visible billing notice without restoring final-text forwarding", () => {
    const notice = formatClaudeProviderFailureNotice(
      {
        category: "provider_capacity",
        reasonCode: "provider_billing_limit",
        message: "billing",
        sourceKind: "permanent",
      },
      "API Error: 403 Insufficient account balance",
    );

    expect(notice).toContain("Claude Code could not run this turn");
    expect(notice).toContain("insufficient account balance");
    expect(notice).toContain("Original provider message");
  });

  it("merges error codes and result text for a non-success subtype so egress detail survives", () => {
    const failure = claudeFailureFromSdkResult({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      api_error_status: 403,
      errors: ["authentication_failed"],
      result: "Failed to authenticate. API Error: 403 Request not allowed",
    });
    expect(failure).not.toBeNull();
    if (!failure) throw new Error("expected failure");
    // The opaque code alone would hide the egress signature; the merged preview
    // keeps "Request not allowed" so the notice classifies it as egress.
    expect(failure.messagePreview).toContain("Request not allowed");
    const notice = formatClaudeProviderFailureNotice(classify(failure.signal.error), failure.messagePreview);
    expect(notice).toContain("before authentication");
    expect(notice).not.toContain("rejected the local Claude authentication");
  });

  it("does not blame auth for a 403 `Request not allowed` (egress / region block)", () => {
    // Anthropic returns this string before authentication, so the credential
    // classification must NOT surface the misleading "run claude auth login"
    // lead — it should enumerate egress / entitlement / auth instead.
    const notice = formatClaudeProviderFailureNotice(
      {
        category: "credential",
        reasonCode: "provider_credential_required",
        message: "forbidden",
        sourceKind: "permanent",
      },
      "Failed to authenticate. API Error: 403 Request not allowed",
    );

    expect(notice).not.toContain("rejected the local Claude authentication");
    expect(notice).toContain("before authentication");
    expect(notice).toContain("daemon.env");
    expect(notice).toContain("Original provider message");
  });

  it("still surfaces the auth lead for a genuine credential failure", () => {
    const notice = formatClaudeProviderFailureNotice(
      {
        category: "credential",
        reasonCode: "provider_credential_required",
        message: "auth",
        sourceKind: "permanent",
      },
      "Failed to authenticate. API Error: 401 invalid x-api-key",
    );

    expect(notice).toContain("rejected the local Claude authentication");
  });
});
