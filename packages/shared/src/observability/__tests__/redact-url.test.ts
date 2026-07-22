import { describe, expect, it } from "vitest";
import { redactUrl } from "../redact-url.js";

describe("redactUrl", () => {
  it("returns the URL unchanged when there is no query string", () => {
    expect(redactUrl("/api/v1/me")).toBe("/api/v1/me");
    expect(redactUrl("/")).toBe("/");
  });

  it("redacts the GitLab URL bearer path segment", () => {
    expect(redactUrl("/api/v1/webhooks/gitlab/secret-bearer")).toBe("/api/v1/webhooks/gitlab/***");
    expect(redactUrl("https://first-tree.test/api/v1/webhooks/gitlab/secret-bearer?x=1")).toBe(
      "https://first-tree.test/api/v1/webhooks/gitlab/***?x=1",
    );
    expect(redactUrl("/api/v1/webhooks/gitlab/secret-bearer/extra")).toBe("/api/v1/webhooks/gitlab/***/extra");
  });

  it("returns the URL unchanged when the query string is empty", () => {
    // Path ends with `?` but no params — keep the trailing `?` to preserve
    // the original shape, since we only redact values, never structure.
    expect(redactUrl("/foo?")).toBe("/foo?");
  });

  it("redacts `token` value", () => {
    expect(redactUrl("/api/v1/ws/admin?token=eyJabc.def.ghi")).toBe("/api/v1/ws/admin?token=***");
  });

  it("redacts other sensitive keys", () => {
    expect(redactUrl("/x?access_token=a")).toBe("/x?access_token=***");
    expect(redactUrl("/x?accessToken=a")).toBe("/x?accessToken=***");
    expect(redactUrl("/x?refresh_token=a")).toBe("/x?refresh_token=***");
    expect(redactUrl("/x?refreshToken=a")).toBe("/x?refreshToken=***");
    expect(redactUrl("/x?jwt=a")).toBe("/x?jwt=***");
    expect(redactUrl("/x?password=a")).toBe("/x?password=***");
    expect(redactUrl("/x?secret=a")).toBe("/x?secret=***");
    expect(redactUrl("/x?api_key=a")).toBe("/x?api_key=***");
    expect(redactUrl("/x?apiKey=a")).toBe("/x?apiKey=***");
    expect(redactUrl("/x?credentials=a")).toBe("/x?credentials=***");
    expect(redactUrl("/x?authorization=Bearer+a")).toBe("/x?authorization=***");
    expect(redactUrl("/x?code=oauth-code&state=oauth-state&ticket=t&claim=c")).toBe(
      "/x?code=***&state=***&ticket=***&claim=***",
    );
  });

  it("preserves non-sensitive params verbatim", () => {
    expect(redactUrl("/api/v1/admin/agents?organizationId=019dfb4a-3ba3-7bb9&page=2&limit=50")).toBe(
      "/api/v1/admin/agents?organizationId=019dfb4a-3ba3-7bb9&page=2&limit=50",
    );
  });

  it("redacts only the sensitive param when mixed with safe ones", () => {
    expect(redactUrl("/api/v1/ws/admin?token=eyJabc&organizationId=019dfb")).toBe(
      "/api/v1/ws/admin?token=***&organizationId=019dfb",
    );
    expect(redactUrl("/x?a=1&token=eyJ&b=2")).toBe("/x?a=1&token=***&b=2");
  });

  it("does not match keys that merely contain a sensitive substring", () => {
    expect(redactUrl("/x?userToken=keep")).toBe("/x?userToken=keep");
  });

  it("matches ASCII case and encoded aliases without normalizing their spelling", () => {
    expect(redactUrl("/x?TOKEN=a&CoDe=b&%63ode=c&accessToken=d&apiKey=e")).toBe(
      "/x?TOKEN=***&CoDe=***&%63ode=***&accessToken=***&apiKey=***",
    );
  });

  it("redacts every duplicate and key-only sensitive occurrence", () => {
    expect(redactUrl("/x?state=A&state=B&code&safe")).toBe("/x?state=***&state=***&code=***&safe");
  });

  it("redacts form-style fragments independently", () => {
    expect(redactUrl("/auth/complete?next=%2Fteam#claim=secret&x=1")).toBe("/auth/complete?next=%2Fteam#claim=***&x=1");
    expect(redactUrl("/x#STATE=a&safe=b")).toBe("/x#STATE=***&safe=b");
  });

  it("fails closed for malformed key encodings", () => {
    expect(redactUrl("/x?%ZZ=canary&x=1#claim=secret")).toBe("/x?***#claim=***");
    expect(redactUrl("/x?safe=1#%E0%A4%A=canary")).toBe("/x?safe=1#***");
  });

  it("handles params with no value (key-only fragments)", () => {
    expect(redactUrl("/x?flag&token=secret")).toBe("/x?flag&token=***");
  });

  it("handles values containing `=` (e.g. base64 padding) safely", () => {
    // Split on the first `=` only, so `==` padding inside a token value stays
    // intact in the (unredacted) safe params and the token itself becomes ***.
    expect(redactUrl("/x?token=abc==&id=xyz==")).toBe("/x?token=***&id=xyz==");
  });

  it("does not parse the value content — long uuid-shaped values pass through", () => {
    expect(redactUrl("/x?organizationId=eyJlooks-like-jwt-but-is-not")).toBe(
      "/x?organizationId=eyJlooks-like-jwt-but-is-not",
    );
  });
});
