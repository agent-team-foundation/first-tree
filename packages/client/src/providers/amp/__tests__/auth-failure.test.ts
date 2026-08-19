import { describe, expect, it } from "vitest";
import { formatAuthHint } from "../../handlers/auth-error-hint.js";
import { publicAmpAuthFailure, sanitizeAmpAuthFailureText } from "../auth-failure.js";

const OFFICIAL_WITH_CREDENTIALS = [
  'No API key found. Starting login flow... AMP_API_KEY=qa-amp-key-placeholder AMP_API_KEY="qa-amp-quoted-placeholder" {"AMP_API_KEY":"qa-amp-json-placeholder"} Authorization: Bearer qa-bearer-placeholder sk-ant-abcdefghijklmnopqrstuvwxyz012345',
  "If your browser does not open automatically, visit:",
  "",
  "https://ampcode.com/auth/cli-login?authToken=qa-one-time-placeholder&state=qa-state-placeholder",
  "",
  "When prompted, paste your code here:",
].join("\n");

describe("Amp auth-failure sanitizer", () => {
  it("strips login URLs and generic credential shapes before formatAuthHint", () => {
    const sanitized = sanitizeAmpAuthFailureText(OFFICIAL_WITH_CREDENTIALS);
    expect(sanitized).not.toMatch(/https?:\/\//i);
    expect(sanitized).not.toMatch(/authToken=|state=|[?&]code=/i);
    expect(sanitized).not.toContain("qa-amp-key-placeholder");
    expect(sanitized).not.toContain("qa-amp-quoted-placeholder");
    expect(sanitized).not.toContain("qa-amp-json-placeholder");
    expect(sanitized).not.toContain("qa-bearer-placeholder");
    expect(sanitized).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz012345");
    expect(sanitized).toContain("No API key found");

    const hint = formatAuthHint("amp", publicAmpAuthFailure(OFFICIAL_WITH_CREDENTIALS));
    expect(hint).toContain("`amp login`");
    expect(hint).toContain("No API key found");
    expect(hint).not.toMatch(/https?:\/\//i);
    expect(hint).not.toMatch(/authToken=|state=|[?&]code=/i);
    expect(hint).not.toContain("qa-one-time-placeholder");
    expect(hint).not.toContain("qa-amp-key-placeholder");
    expect(hint).not.toContain("qa-amp-quoted-placeholder");
    expect(hint).not.toContain("qa-amp-json-placeholder");
    expect(hint).not.toContain("qa-bearer-placeholder");
    expect(hint).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz012345");
    expect(hint).not.toContain("paste your code");
  });

  it("strips shell-quoted and JSON AMP_API_KEY forms that shared redaction misses", () => {
    const quoted = 'Invalid API key; AMP_API_KEY="qa-amp-quoted-placeholder"';
    const json = 'Invalid API key; {"AMP_API_KEY":"qa-amp-json-placeholder"}';
    for (const sample of [quoted, json]) {
      const sanitized = sanitizeAmpAuthFailureText(sample);
      expect(sanitized).toContain("Invalid API key");
      expect(sanitized).toContain("AMP_API_KEY=[REDACTED]");
      expect(sanitized).not.toContain("qa-amp-quoted-placeholder");
      expect(sanitized).not.toContain("qa-amp-json-placeholder");
      const summary = publicAmpAuthFailure(sample);
      expect(summary).not.toContain("qa-amp-quoted-placeholder");
      expect(summary).not.toContain("qa-amp-json-placeholder");
    }
  });
});
