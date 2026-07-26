// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

const analyticsMocks = vi.hoisted(() => ({ trackEvent: vi.fn() }));

vi.mock("../../analytics.js", () => analyticsMocks);

import {
  authEntryPoint,
  authProviderForCallbackPath,
  beginAuthAttempt,
  finishAuthAttempt,
  normalizeAuthFailureReason,
  normalizeAuthJoinPath,
} from "../auth-analytics.js";

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
});

describe("auth analytics", () => {
  it("joins OAuth start and account creation without storing redirect details", () => {
    const scanAttemptId = "123e4567-e89b-42d3-a456-426614174000";
    const attemptId = beginAuthAttempt(
      "github",
      `/quickstart?campaign=production-scan&repo=secret&attempt=${scanAttemptId}&variant=control`,
    );

    expect(attemptId).toEqual(expect.any(String));
    expect(analyticsMocks.trackEvent).toHaveBeenCalledWith("auth_started", {
      auth_attempt_id: attemptId,
      provider: "github",
      entry_point: "campaign",
      scan_attempt_id: scanAttemptId,
      variant: "control",
    });
    const stored = window.sessionStorage.getItem("first-tree:auth-attempt") ?? "";
    expect(stored).not.toContain("repo=secret");

    finishAuthAttempt({
      provider: "github",
      result: "success",
      next: `/quickstart?campaign=production-scan&repo=secret&attempt=${scanAttemptId}&variant=control`,
      joinPath: "solo",
      accountCreated: true,
    });

    expect(analyticsMocks.trackEvent).toHaveBeenCalledWith("auth_result", {
      auth_attempt_id: attemptId,
      provider: "github",
      result: "success",
      entry_point: "campaign",
      join_path: "solo",
      account_type: "created",
      scan_attempt_id: scanAttemptId,
      variant: "control",
    });
    expect(analyticsMocks.trackEvent).toHaveBeenCalledWith("sign_up", {
      auth_attempt_id: attemptId,
      method: "github",
      entry_point: "campaign",
      scan_attempt_id: scanAttemptId,
      variant: "control",
    });
    expect(window.sessionStorage.getItem("first-tree:auth-attempt")).toBeNull();
  });

  it("keeps callback failures low-cardinality and does not emit sign_up", () => {
    beginAuthAttempt("google", "/invite/private-token");
    finishAuthAttempt({
      provider: "google",
      result: "failed",
      next: "/invite/private-token",
      joinPath: normalizeAuthJoinPath("unexpected"),
      reasonCode: normalizeAuthFailureReason("attacker-controlled-value"),
      accountCreated: null,
    });

    expect(analyticsMocks.trackEvent).toHaveBeenLastCalledWith(
      "auth_result",
      expect.objectContaining({
        provider: "google",
        result: "failed",
        entry_point: "invite",
        join_path: "unknown",
        account_type: "unknown",
        reason_code: "unknown",
      }),
    );
    expect(analyticsMocks.trackEvent.mock.calls.some(([name]) => name === "sign_up")).toBe(false);
  });

  it("counts a committed account once when bootstrap fails, then treats the retry as reused", () => {
    const firstAttemptId = beginAuthAttempt("github", "/invite/missing-token");
    finishAuthAttempt({
      provider: "github",
      result: "failed",
      next: "/invite/missing-token",
      reasonCode: "invite-invalid",
      accountCreated: true,
    });

    expect(analyticsMocks.trackEvent).toHaveBeenCalledWith(
      "auth_result",
      expect.objectContaining({
        auth_attempt_id: firstAttemptId,
        result: "failed",
        account_type: "created",
        reason_code: "invite-invalid",
      }),
    );
    expect(analyticsMocks.trackEvent).toHaveBeenCalledWith(
      "sign_up",
      expect.objectContaining({ auth_attempt_id: firstAttemptId, method: "github" }),
    );

    // Reloading the callback cannot emit a second conversion: the first
    // completion consumed its matching anonymous attempt.
    const callCountAfterFirstCompletion = analyticsMocks.trackEvent.mock.calls.length;
    finishAuthAttempt({
      provider: "github",
      result: "failed",
      next: "/invite/missing-token",
      reasonCode: "invite-invalid",
      accountCreated: true,
    });
    expect(analyticsMocks.trackEvent).toHaveBeenCalledTimes(callCountAfterFirstCompletion);

    beginAuthAttempt("github", "/");
    finishAuthAttempt({
      provider: "github",
      result: "success",
      next: "/",
      joinPath: "solo",
      accountCreated: false,
    });
    expect(analyticsMocks.trackEvent.mock.calls.filter(([name]) => name === "sign_up")).toHaveLength(1);
  });

  it("does not fabricate an auth result without a matching provider attempt", () => {
    finishAuthAttempt({ provider: "github", result: "failed", next: "/", reasonCode: "provider-denied" });
    expect(analyticsMocks.trackEvent).not.toHaveBeenCalled();

    beginAuthAttempt("google", "/");
    const callsAfterGoogleStart = analyticsMocks.trackEvent.mock.calls.length;
    finishAuthAttempt({ provider: "github", result: "success", next: "/", accountCreated: false });
    expect(analyticsMocks.trackEvent).toHaveBeenCalledTimes(callsAfterGoogleStart);
    expect(window.sessionStorage.getItem("first-tree:auth-attempt")).not.toBeNull();
  });

  it("classifies callback paths and safe entry points", () => {
    expect(authProviderForCallbackPath("/auth/complete")).toBe("google");
    expect(authProviderForCallbackPath("/auth/github/complete")).toBe("github");
    expect(authEntryPoint("/")).toBe("login");
    expect(authEntryPoint("/settings/github")).toBe("deep_link");
    expect(normalizeAuthFailureReason("provider-denied")).toBe("provider-denied");
  });
});
