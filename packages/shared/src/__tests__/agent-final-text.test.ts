import { describe, expect, it } from "vitest";
import { AGENT_FINAL_TEXT_METADATA_KEY, isAgentFinalTextMetadata } from "../schemas/message.js";

/**
 * `isAgentFinalTextMetadata` is the shared reader the web uses to identify a
 * stored agent final-text mirror row. The server stamps the matching flag at
 * send time (see services/message.ts); both sides key off the same constant.
 */
describe("isAgentFinalTextMetadata", () => {
  it("is true only when the flag is the boolean true", () => {
    expect(isAgentFinalTextMetadata({ [AGENT_FINAL_TEXT_METADATA_KEY]: true })).toBe(true);
  });

  it("is false for a normal message (flag absent)", () => {
    expect(isAgentFinalTextMetadata({})).toBe(false);
    expect(isAgentFinalTextMetadata({ mentions: ["abc"] })).toBe(false);
  });

  it("is false for null / undefined metadata", () => {
    expect(isAgentFinalTextMetadata(null)).toBe(false);
    expect(isAgentFinalTextMetadata(undefined)).toBe(false);
  });

  it("does not treat a truthy non-true value as a final-text marker", () => {
    expect(isAgentFinalTextMetadata({ [AGENT_FINAL_TEXT_METADATA_KEY]: "true" })).toBe(false);
    expect(isAgentFinalTextMetadata({ [AGENT_FINAL_TEXT_METADATA_KEY]: 1 })).toBe(false);
  });
});
