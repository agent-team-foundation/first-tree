import { describe, expect, it } from "vitest";
import { formatAuthHint } from "../../handlers/auth-error-hint.js";
import {
  discardDeepseekAuthorizationMaterial,
  publicDeepseekAuthFailure,
  sanitizeDeepseekAuthFailureText,
} from "../auth-failure.js";

const RAW = [
  'DEEPSEEK_API_KEY=qa-secret DEEPSEEK_API_KEY="qa-quoted" {"DEEPSEEK_API_KEY":"qa-json"}',
  "https://platform.deepseek.com/auth?token=qa-one-time",
].join("\n");

describe("DeepSeek auth failure sanitization", () => {
  it("strips API key material and URLs before chat-visible auth copy", () => {
    const cleaned = sanitizeDeepseekAuthFailureText(RAW);
    expect(cleaned).not.toContain("qa-secret");
    expect(cleaned).not.toContain("qa-quoted");
    expect(cleaned).not.toContain("qa-json");
    expect(cleaned).not.toMatch(/https?:\/\//i);
    expect(discardDeepseekAuthorizationMaterial(RAW)).toContain("DEEPSEEK_API_KEY=[REDACTED]");
  });

  it("feeds formatAuthHint with sanitized credential copy only", () => {
    const hint = formatAuthHint("deepseek-harness", publicDeepseekAuthFailure(RAW));
    expect(hint).toContain("DEEPSEEK_API_KEY");
    expect(hint).toContain("Runtime → Environment variables");
    expect(hint).toContain("Mark as sensitive");
    expect(hint).toContain("not First Tree's");
    expect(hint).not.toContain("qa-secret");
    expect(hint).not.toMatch(/https?:\/\//i);
  });
});
