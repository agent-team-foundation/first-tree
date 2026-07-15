import { describe, expect, it } from "vitest";
import { redactCredentialText } from "../credential-redaction.js";

describe("redactCredentialText", () => {
  it("redacts authorization headers and bare bearer tokens without truncation leaks", () => {
    expect(redactCredentialText("Authorization: Bearer abcdefghijkl")).toBe("Authorization: [REDACTED]");
    expect(redactCredentialText("curl -H 'Authorization=Bearer abcdefghijkl'")).toBe(
      "curl -H 'Authorization=[REDACTED]'",
    );
    expect(redactCredentialText("retry with Bearer abcdefghijkl")).toBe("retry with Bearer [REDACTED]");
  });

  it("redacts URL userinfo and sensitive query values", () => {
    expect(redactCredentialText("https://user:pass@example.com/repo.git")).toBe(
      "https://[REDACTED]@example.com/repo.git",
    );
    expect(redactCredentialText("https://example.com/callback?token=abc123&safe=1")).toBe(
      "https://example.com/callback?token=[REDACTED]&safe=1",
    );
  });

  it("redacts common provider credentials", () => {
    const input = [
      "github_pat_1234567890abcdef_1234567890abcdef",
      "ghp_123456789012345678901234567890123456",
      "AKIA1234567890ABCDEF",
      ["xox", "b-123456789012-abcdefghijklmnopqrst"].join(""),
      "sk-proj-123456789012345678901234567890",
      "sk-ant-123456789012345678901234567890",
      "aws_session_token=abcdefghijklmnop",
    ].join("\n");

    const redacted = redactCredentialText(input);
    expect(redacted).not.toContain("github_pat_");
    expect(redacted).not.toContain("ghp_");
    expect(redacted).not.toContain("AKIA1234567890ABCDEF");
    expect(redacted).not.toContain("xoxb-");
    expect(redacted).not.toContain("sk-proj-");
    expect(redacted).not.toContain("sk-ant-");
    expect(redacted).not.toContain("abcdefghijklmnop");
  });
});
