import { describe, expect, it } from "vitest";
import { redactErrorPreview } from "../runtime/redact-error-preview.js";

/**
 * `redactErrorPreview` is the boundary helper that turns "safe in logs but NOT
 * chat" preview text (per `Classification.message`'s contract) into something
 * that can leave the local-log surface and ride a chat-visible session event.
 *
 * Tests are split into:
 *  - REDACT — patterns that MUST be sanitised. False negatives here are
 *    credential leaks; treat additions as P1 fixes.
 *  - KEEP   — prose / shapes the helper must leave alone. False positives are
 *    a readability nuisance but not a security issue; covered to prevent
 *    over-eager regexes from creeping in.
 */

describe("redactErrorPreview — secret patterns are sanitised", () => {
  it("scrubs URL-embedded basic auth (the git-clone shape called out by Codex P1)", () => {
    // Verbatim shape of a GitMirrorError wrapping a clone whose `remote.origin.url`
    // carries a PAT inline (legacy / hand-written agentRuntimeConfig.gitRepos[].url).
    const input =
      "git clone https://liuchao001:ghp_AbCdEf0123456789abcdef0123456789abcd@github.com/agent-team-foundation/private.git /agents/x exited with code 128: Cloning into '/agents/x'... remote: Repository not found.";
    const out = redactErrorPreview(input);
    expect(out).not.toContain("ghp_AbCdEf0123456789abcdef0123456789abcd");
    expect(out).not.toContain("liuchao001:ghp_");
    expect(out).toContain("https://[REDACTED]@github.com");
    // host + path stay so the operator can still tell which repo failed.
    expect(out).toContain("github.com/agent-team-foundation/private.git");
  });

  it("scrubs ssh:// URL basic auth", () => {
    const input = "fatal: unable to access 'ssh://user:passwd123@git.internal/x.git/': connection refused";
    const out = redactErrorPreview(input);
    expect(out).not.toContain("passwd123");
    expect(out).toContain("ssh://[REDACTED]@git.internal/x.git");
  });

  it("scrubs vendor-prefixed tokens that appear bare (not inside a URL)", () => {
    expect(redactErrorPreview("X-GitHub-Token: ghp_AbCdEf0123456789abcdef0123456789abcd")).toMatch(/ghp_\[REDACTED\]/);
    expect(redactErrorPreview("hint: server-to-server token ghs_AbCdEf0123456789abcdef0123456789abcd")).toMatch(
      /ghs_\[REDACTED\]/,
    );
    expect(redactErrorPreview("github_pat_11ABCDEFG0AbCdEf01234567_AbCdEf0123456789abcdef0123456789")).toMatch(
      /github_pat_\[REDACTED\]/,
    );
    expect(redactErrorPreview("aws creds AKIAIOSFODNN7EXAMPLE leaked")).toContain("AKIA[REDACTED]");
    expect(redactErrorPreview("sk-ant-api03-AbCdEfGh1234567890_-zyxwvut987654321")).toContain("sk-[REDACTED]");
    expect(redactErrorPreview("slack hook xoxb-1234567890-AbCdEf-0123456789")).toContain("xox[REDACTED]");
  });

  it("scrubs Authorization headers and bare Bearer tokens", () => {
    const auth = redactErrorPreview("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig");
    expect(auth).toContain("Authorization: [REDACTED]");
    expect(auth).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");

    const bare = redactErrorPreview("sent Bearer abcdef0123456789xyz to upstream");
    expect(bare).toContain("Bearer [REDACTED]");
    expect(bare).not.toContain("abcdef0123456789xyz");
  });

  it("scrubs credential-bearing key=value pairs in query strings and configs", () => {
    expect(redactErrorPreview("https://api.example.com/x?token=hunter22hunter22hunter")).toContain("?token=[REDACTED]");
    expect(redactErrorPreview("retry url ?access_token=AbCdEf0123 next")).toContain("access_token=[REDACTED]");
    // The open + close JSON quotes around the VALUE are preserved (value's
    // own delimiter), only the value itself becomes `[REDACTED]`.
    expect(redactErrorPreview('config: {"api_key": "k-9999999999"}')).toMatch(/"api_key"\s*:\s*"\[REDACTED\]"/);
    expect(redactErrorPreview("PASSWORD=hunter22 in env")).toContain("PASSWORD=[REDACTED]");
    expect(redactErrorPreview("client_secret=oauth-xyz-9999 ...")).toContain("client_secret=[REDACTED]");
  });

  it("truncates AFTER redacting so half-tokens never escape past the boundary", () => {
    const longTail = `note ${"a".repeat(400)} Authorization: Bearer ${"X".repeat(40)}`;
    const out = redactErrorPreview(longTail, 50);
    // Within the 50-char window, no portion of `X`-tail bleeds through.
    expect(out).not.toContain("X");
    expect(out.length).toBeLessThanOrEqual(51); // 50 + truncation marker
  });

  it("appends a truncation marker only when actually clipped", () => {
    expect(redactErrorPreview("short", 256)).toBe("short");
    expect(redactErrorPreview("abcdefghij", 5).endsWith("…")).toBe(true);
  });
});

describe("redactErrorPreview — ordinary text is left alone", () => {
  it("leaves the prod incident message readable (URL has no embedded creds)", () => {
    const input =
      "git clone https://github.com/L42y/BRG.git /agents/x exited with code 128: Cloning into '/agents/x'... remote: Repository not found. fatal: repository 'https://github.com/L42y/BRG.git/' not found";
    const out = redactErrorPreview(input);
    expect(out).toContain("https://github.com/L42y/BRG.git");
    expect(out).toContain("Repository not found");
    expect(out).not.toContain("[REDACTED]");
  });

  it("does NOT redact ordinary uses of words like `key` / `password` without a value", () => {
    expect(redactErrorPreview("press any key to continue")).toBe("press any key to continue");
    expect(redactErrorPreview("the password could not be read")).toBe("the password could not be read");
    expect(redactErrorPreview("missing config key 'foo' in section")).toBe("missing config key 'foo' in section");
  });

  it("handles empty / undefined-shaped input", () => {
    expect(redactErrorPreview("")).toBe("");
  });

  it("does NOT trip on commit SHAs / numeric IDs / branch refs", () => {
    expect(redactErrorPreview("HEAD is at 9862c324 docs: clarify update channel env deprecation (#970)")).toContain(
      "9862c324",
    );
    expect(redactErrorPreview("refs/heads/feature/x-1234 did not match")).toContain("refs/heads/feature/x-1234");
  });
});
