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
 *
 * **Assertion style note:** for credential-leak guards, lean on
 * `.not.toContain(<actual credential>)` rather than just
 * `.toContain("[REDACTED]")`. A substring assertion on `[REDACTED]` can pass
 * while the unredacted credential still trails immediately after — exactly
 * how the original `Authorization: Basic <b64>` leak slipped past the
 * substring-only fixture before being caught by an edge-case probe.
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

  it("scrubs URL basic auth for non-HTTP schemes (database / queue connection strings)", () => {
    // Defense-in-depth: an SDK that logs its own connection string on
    // failure (DB drivers, AMQP clients, redis libs) can ride into the
    // session-event payload via this helper. Widening the scheme whitelist
    // to RFC-3986-shaped schemes covers all of these at zero pattern cost.
    expect(redactErrorPreview("PG connect failed: postgres://app:secret_pg_99@db:5432/main")).not.toContain(
      "secret_pg_99",
    );
    expect(redactErrorPreview("mysql://root:hunter2pwd@db.internal/foo")).not.toContain("hunter2pwd");
    expect(redactErrorPreview("mongodb+srv://svcuser:longerpassword@cluster.example/app")).not.toContain(
      "longerpassword",
    );
    expect(redactErrorPreview("redis://default:redis_pwd_99@cache:6379/0")).not.toContain("redis_pwd_99");
  });

  it("scrubs URL userinfo in the empty-username and bare-token forms (PR #975 follow-up gap)", () => {
    // Codex's round-3 probe on PR #975 d30e8926 caught the previous
    // `([^\s:@/]+):([^\s@/]+)@` regex requiring BOTH username and password
    // to be non-empty with a colon between them. Two real-world userinfo
    // shapes slipped through:
    //
    //  (a) Empty username — common in DB connection strings, e.g.
    //      `redis://:redis_pwd_99@cache:6379/0`
    //      `postgres://:secret_pg_99@db:5432/main`
    //  (b) Single-component bare token — common for OAuth-token-in-URL:
    //      `https://oauth-token-AbCd1234@github.com/owner/repo`
    //
    // Both must be redacted. `.not.toContain(<actual credential>)` is the
    // load-bearing assertion — substring checks on `[REDACTED]` alone
    // would pass through a "scheme + [REDACTED] + leftover credential"
    // partial redaction (the same false-confidence mode that hid the
    // round-2 Authorization Basic leak).
    const emptyUserRedis = redactErrorPreview("redis connect failed: redis://:redis_pwd_99@cache:6379/0");
    expect(emptyUserRedis).not.toContain("redis_pwd_99");
    expect(emptyUserRedis).toContain("redis://[REDACTED]@cache:6379/0");

    const emptyUserPg = redactErrorPreview("dial timeout postgres://:secret_pg_99@db:5432/main");
    expect(emptyUserPg).not.toContain("secret_pg_99");
    expect(emptyUserPg).toContain("postgres://[REDACTED]@db:5432/main");

    const bareTokenGitHub = redactErrorPreview(
      "git fetch failed: https://oauth-token-AbCd1234@github.com/owner/repo.git",
    );
    expect(bareTokenGitHub).not.toContain("oauth-token-AbCd1234");
    expect(bareTokenGitHub).toContain("https://[REDACTED]@github.com/owner/repo.git");

    // Regression guard: the standard `user:pass` form (the round-1 case)
    // still works through the collapsed single-blob userinfo regex.
    const standard = redactErrorPreview("https://liu:ghp_AbCdEf0123456789abcdef0123456789abcd@github.com/x.git");
    expect(standard).not.toContain("ghp_AbCdEf0123456789abcdef0123456789abcd");
    expect(standard).not.toContain("liu:ghp_");
    expect(standard).toContain("https://[REDACTED]@github.com/x.git");
  });

  it("scrubs vendor-prefixed tokens that appear bare (not inside a URL)", () => {
    expect(redactErrorPreview("X-GitHub-Token: ghp_AbCdEf0123456789abcdef0123456789abcd")).toMatch(/\[REDACTED:ghp\]/);
    expect(redactErrorPreview("hint: server-to-server token ghs_AbCdEf0123456789abcdef0123456789abcd")).toMatch(
      /\[REDACTED:ghs\]/,
    );
    // `ghr_` refresh token — added alongside the existing `ghp/ghs/gho/ghu` set.
    expect(redactErrorPreview("refresh ghr_AbCdEf0123456789abcdef0123456789abcd")).toMatch(/\[REDACTED:ghr\]/);
    expect(redactErrorPreview("github_pat_11ABCDEFG0AbCdEf01234567_AbCdEf0123456789abcdef0123456789")).toContain(
      "[REDACTED:github_pat]",
    );
    expect(redactErrorPreview("aws creds AKIAIOSFODNN7EXAMPLE leaked")).toContain("[REDACTED:AKIA]");
    // AWS session token (`ASIA*`) — same shape, different prefix.
    expect(redactErrorPreview("session ASIAIOSFODNN7EXAMPLE token")).toContain("[REDACTED:ASIA]");
    // sk- family: with vendor segment (sk-ant-..., sk-proj-...) AND the
    // older bare sk-<token> shape (no vendor segment).
    expect(redactErrorPreview("sk-ant-api03-AbCdEfGh1234567890_-zyxwvut987654321")).toContain("[REDACTED:sk]");
    expect(redactErrorPreview("legacy sk-AbCdEfGh1234567890zyxwvut987654321ok")).toContain("[REDACTED:sk]");
    expect(redactErrorPreview("slack hook xoxb-1234567890-AbCdEf-0123456789")).toContain("[REDACTED:xox]");
  });

  it("scrubs Authorization headers — every scheme, full credential (P1 regression guard)", () => {
    // The original `(?:Bearer\s+)?\S+` only ate the scheme word for non-Bearer
    // schemes; `Authorization: Basic dXNlcjpwYXNzMTIz` produced
    // `Authorization: [REDACTED] dXNlcjpwYXNzMTIz` and the b64 credential
    // landed in chat-visible session events. The `.not.toContain(<actual
    // credential>)` assertions here are the load-bearing ones — substring
    // checks on `[REDACTED]` alone pass through this leak.
    const bearer = redactErrorPreview("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig");
    expect(bearer).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(bearer).not.toContain("payload.sig");
    expect(bearer).toContain("Authorization: [REDACTED]");

    const basic = redactErrorPreview("Authorization: Basic dXNlcjpwYXNzMTIz");
    expect(basic).not.toContain("dXNlcjpwYXNzMTIz");
    expect(basic).toContain("Authorization: [REDACTED]");

    const digest = redactErrorPreview('Authorization: Digest username="x", realm="y", nonce="zzzzzz"');
    expect(digest).not.toMatch(/username="x"|realm="y"|nonce="zzzzzz"/);
    expect(digest).toContain("Authorization: [REDACTED]");

    const tokenScheme = redactErrorPreview("Authorization: token abc123xyz789supersecret");
    expect(tokenScheme).not.toContain("abc123xyz789supersecret");
    expect(tokenScheme).toContain("Authorization: [REDACTED]");

    const apikey = redactErrorPreview("Authorization: ApiKey privkey_long_value_999");
    expect(apikey).not.toContain("privkey_long_value_999");
    expect(apikey).toContain("Authorization: [REDACTED]");

    // Bare Bearer outside an Authorization header still works.
    const bare = redactErrorPreview("sent Bearer abcdef0123456789xyz to upstream");
    expect(bare).toContain("Bearer [REDACTED]");
    expect(bare).not.toContain("abcdef0123456789xyz");
  });

  it("scrubs credential-bearing key=value pairs in query strings and configs", () => {
    expect(redactErrorPreview("https://api.example.com/x?token=hunter22hunter22hunter")).toContain("?token=[REDACTED]");
    expect(redactErrorPreview("retry url ?access_token=AbCdEf0123 next")).toContain("access_token=[REDACTED]");
    // GitLab-style `private_token` query param — added to credKey set.
    expect(redactErrorPreview("retry url ?private_token=glpat-AbCdEf01 next")).toContain("private_token=[REDACTED]");
    // The open + close JSON quotes around the VALUE are preserved (value's
    // own delimiter), only the value itself becomes `[REDACTED]`.
    expect(redactErrorPreview('config: {"api_key": "k-9999999999"}')).toMatch(/"api_key"\s*:\s*"\[REDACTED\]"/);
    expect(redactErrorPreview("PASSWORD=hunter22 in env")).toContain("PASSWORD=[REDACTED]");
    expect(redactErrorPreview("client_secret=oauth-xyz-9999 ...")).toContain("client_secret=[REDACTED]");
  });

  it("does NOT stutter-redact when a vendor token is itself the value of a key=value pair", () => {
    // Regression guard for the AKIA cosmetic noted by code-reviewer: step-2
    // turns `AKIA…` into `[REDACTED:AKIA]`; if step-5's value class could
    // extract 4 consecutive chars from the placeholder, the result would
    // double-redact to `api_key=[REDACTED][REDACTED:AKIA]`. The `:` inside
    // the placeholder is the load-bearing exclusion.
    const akiaPair = redactErrorPreview("api_key=AKIA1234567890ABCDEF");
    expect(akiaPair).toContain("[REDACTED:AKIA]");
    expect(akiaPair).not.toMatch(/\[REDACTED\]\[REDACTED/);

    const ghpPair = redactErrorPreview("token=ghp_AbCdEf0123456789abcdef0123456789abcd");
    expect(ghpPair).toContain("[REDACTED:ghp]");
    expect(ghpPair).not.toMatch(/\[REDACTED\]\[REDACTED/);
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

  it("does NOT match credKey as the suffix of an unrelated identifier", () => {
    // The `(?<![\w-])` negative lookbehind is what makes `X-Custom-Token`
    // / `X-API-Token-Header` ordinary prose instead of a credential pair.
    expect(redactErrorPreview("X-Custom-Token-Header: somevalue1234567890")).toBe(
      "X-Custom-Token-Header: somevalue1234567890",
    );
    expect(redactErrorPreview("X-API-Token=plain-value-ok")).toBe("X-API-Token=plain-value-ok");
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
