import { describe, expect, it } from "vitest";
import { extractLastUpdateAttempt } from "../services/client.js";

/**
 * `extractLastUpdateAttempt` is what the admin / `/me/clients` routes call
 * to flatten the structured update attempt out of the catch-all `metadata`
 * jsonb. Validation tolerance matters here — older or future-rev clients
 * shouldn't crash the listing endpoints.
 */
describe("extractLastUpdateAttempt", () => {
  it("returns null when metadata is missing", () => {
    expect(extractLastUpdateAttempt(null)).toBeNull();
    expect(extractLastUpdateAttempt(undefined)).toBeNull();
  });

  it("returns null when metadata has no lastUpdateAttempt key", () => {
    expect(extractLastUpdateAttempt({ capabilities: { claude: { state: "ok" } } })).toBeNull();
  });

  it("returns the parsed attempt when valid", () => {
    const attempt = {
      result: "ok" as const,
      target: "0.14.8",
      currentBefore: "0.14.6",
      installedVersion: "0.14.8",
      reason: null,
      at: "2026-05-20T00:00:00.000Z",
    };
    expect(extractLastUpdateAttempt({ lastUpdateAttempt: attempt })).toEqual(attempt);
  });

  it("returns null when the sub-object fails schema validation", () => {
    expect(
      extractLastUpdateAttempt({
        lastUpdateAttempt: { result: "weird-state", target: "0.14.8" },
      }),
    ).toBeNull();
  });

  it("ignores irrelevant peer keys in metadata", () => {
    const attempt = {
      result: "failed" as const,
      target: "0.14.9",
      currentBefore: "0.14.8",
      installedVersion: null,
      reason: "npm install -g exited with code 1: EACCES",
      at: "2026-05-20T00:01:00.000Z",
    };
    const got = extractLastUpdateAttempt({
      capabilities: { claude: { state: "ok" } },
      lastUpdateAttempt: attempt,
      somethingElse: 42,
    });
    expect(got).toEqual(attempt);
  });
});
