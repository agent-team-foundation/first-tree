import type {
  SDKAPIRetryMessage,
  SDKAssistantMessage,
  SDKAssistantMessageError,
  SDKAuthStatusMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { isClaudeAuthError } from "../handlers/auth-error-hint.js";
import { detectClaudeAuthFailure } from "../handlers/claude-code.js";

/**
 * Architectural-fragility guard for the Claude-side auth-failure detector.
 *
 * `detectClaudeAuthFailure` infers its message-shape contract from the SDK's
 * `.d.ts` types, NOT from a documented runtime contract. An SDK internal
 * restructure (collapsing message types, renaming `subtype`, moving the
 * terminal auth signal to `result`) would silently break detection: the
 * runtime regresses to dumping the opaque raw SDK error, which is exactly
 * the failure mode PR #618 set out to fix.
 *
 * Two layers of protection here:
 *
 *   1. **Compile-time exhaustiveness over `SDKAssistantMessageError`** — the
 *      `KNOWN_CODES` table is typed `Record<SDKAssistantMessageError, ...>`,
 *      so if Anthropic adds a new union member (e.g. `tos_violation`), the
 *      typecheck fails until someone explicitly triages it. That's the
 *      forcing function: a new error code can't slip past unclassified.
 *
 *   2. **Runtime fixtures typed against the SDK message interfaces** — every
 *      positive / negative case is built from `SDKAssistantMessage`,
 *      `SDKAuthStatusMessage`, `SDKAPIRetryMessage` so a rename / field-drop
 *      in the SDK breaks compilation rather than silently producing junk.
 */

const FIXTURE_UUID = "00000000-0000-7000-8000-000000000000" as const;
const FIXTURE_SESSION_ID = "session-fixture";

function makeAssistantMessage(error: SDKAssistantMessageError | undefined): SDKAssistantMessage {
  const base = {
    type: "assistant",
    // `BetaMessage` is opaque to this test — the detector never reads its
    // contents. Casting through `unknown` keeps the test focused on the
    // fields the detector actually inspects (`type`, `error`).
    message: {} as SDKAssistantMessage["message"],
    parent_tool_use_id: null,
    uuid: FIXTURE_UUID,
    session_id: FIXTURE_SESSION_ID,
  } satisfies Omit<SDKAssistantMessage, "error">;
  return error === undefined ? base : { ...base, error };
}

function makeAuthStatusMessage(error: string | undefined): SDKAuthStatusMessage {
  const base = {
    type: "auth_status",
    isAuthenticating: error === undefined,
    output: [],
    uuid: FIXTURE_UUID,
    session_id: FIXTURE_SESSION_ID,
  } satisfies Omit<SDKAuthStatusMessage, "error">;
  return error === undefined ? base : { ...base, error };
}

function makeApiRetryMessage(error: SDKAssistantMessageError): SDKAPIRetryMessage {
  return {
    type: "system",
    subtype: "api_retry",
    attempt: 1,
    max_retries: 3,
    retry_delay_ms: 500,
    error_status: 401,
    error,
    uuid: FIXTURE_UUID,
    session_id: FIXTURE_SESSION_ID,
  };
}

describe("SDKAssistantMessageError union — exhaustive classification", () => {
  it("classifies every union member; adding a new SDK code breaks compile", () => {
    // The Record type forces compile-time exhaustiveness. If Anthropic ships
    // a new code (e.g. `tos_violation`), this object becomes incomplete and
    // the typecheck fails — that's the intended forcing function. When the
    // typecheck fails, someone must consciously decide whether the new code
    // is an auth signal or not, and add it here AND update isClaudeAuthError.
    const KNOWN_CODES: Record<SDKAssistantMessageError, boolean> = {
      authentication_failed: true,
      billing_error: false,
      rate_limit: false,
      invalid_request: false,
      server_error: false,
      unknown: false,
      max_output_tokens: false,
    };
    for (const [code, expectedIsAuth] of Object.entries(KNOWN_CODES)) {
      expect(isClaudeAuthError(code), `code=${code}`).toBe(expectedIsAuth);
    }
  });
});

describe("detectClaudeAuthFailure — positive cases", () => {
  it("triggers on assistant.error === 'authentication_failed'", () => {
    const msg = makeAssistantMessage("authentication_failed");
    expect(detectClaudeAuthFailure(msg)).toEqual({ rawMessage: "authentication_failed" });
  });

  it("triggers on auth_status with a non-empty error string and quotes it verbatim", () => {
    const msg = makeAuthStatusMessage("OAuth refresh failed: invalid_grant");
    expect(detectClaudeAuthFailure(msg)).toEqual({ rawMessage: "OAuth refresh failed: invalid_grant" });
  });
});

describe("detectClaudeAuthFailure — negative cases (drift counter-examples)", () => {
  it("does NOT trigger on assistant.error for other typed codes", () => {
    // Hand-listed instead of derived from the Record above because the test's
    // value is in being explicit: each non-auth code is intentional. If a new
    // code lands, the exhaustiveness test forces a triage; this loop just
    // proves the current classification is wired through detect→isAuthError.
    const nonAuthCodes: readonly SDKAssistantMessageError[] = [
      "billing_error",
      "rate_limit",
      "invalid_request",
      "server_error",
      "unknown",
      "max_output_tokens",
    ];
    for (const code of nonAuthCodes) {
      const msg = makeAssistantMessage(code);
      expect(detectClaudeAuthFailure(msg), `code=${code}`).toBeNull();
    }
  });

  it("does NOT trigger on assistant message without an error field", () => {
    const msg = makeAssistantMessage(undefined);
    expect(detectClaudeAuthFailure(msg)).toBeNull();
  });

  it("does NOT trigger on auth_status with empty or missing error", () => {
    expect(detectClaudeAuthFailure(makeAuthStatusMessage(undefined))).toBeNull();
    expect(detectClaudeAuthFailure(makeAuthStatusMessage(""))).toBeNull();
  });

  it("does NOT trigger on api_retry — deliberately dropped to avoid pre-attempt false alarms", () => {
    // api_retry fires BEFORE the SDK's next retry attempt; if the retry then
    // succeeds, an emitted hint would have been wrong. The detector waits
    // for the authoritative post-failure signals (`assistant.error` /
    // `auth_status.error`) — see the function docblock for the rationale.
    const msg = makeApiRetryMessage("authentication_failed");
    expect(detectClaudeAuthFailure(msg)).toBeNull();
  });
});

describe("detectClaudeAuthFailure — malformed input tolerance", () => {
  it("returns null for null / undefined / non-object / primitive input", () => {
    expect(detectClaudeAuthFailure(null)).toBeNull();
    expect(detectClaudeAuthFailure(undefined)).toBeNull();
    expect(detectClaudeAuthFailure("not an object")).toBeNull();
    expect(detectClaudeAuthFailure(42)).toBeNull();
    expect(detectClaudeAuthFailure(true)).toBeNull();
    expect(detectClaudeAuthFailure([])).toBeNull();
  });

  it("returns null for objects with unknown / missing type discriminator", () => {
    expect(detectClaudeAuthFailure({})).toBeNull();
    expect(detectClaudeAuthFailure({ type: undefined })).toBeNull();
    expect(detectClaudeAuthFailure({ type: "user", error: "authentication_failed" })).toBeNull();
    expect(detectClaudeAuthFailure({ type: "tool_result", error: "authentication_failed" })).toBeNull();
  });

  it("returns null for auth_status whose error field is not a string", () => {
    // The SDK types `error?: string`, but the message arrives over a JSON
    // boundary — a future SDK could ship a richer object. We require string
    // before quoting it into a chat-timeline message.
    expect(detectClaudeAuthFailure({ type: "auth_status", error: 401 })).toBeNull();
    expect(detectClaudeAuthFailure({ type: "auth_status", error: { code: "invalid_grant" } })).toBeNull();
  });
});
