import { SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { buildRateLimitError, stampRateLimitAttrs } from "../rate-limit-error-builder.js";

/**
 * Coverage for the builder extracted out of `app.ts` so the @fastify/rate-limit
 * 429 path doesn't regress silently. Two contracts under test:
 *   1. The Error returned to fastify-rate-limit is an actual `Error` instance
 *      with `statusCode = 429` (otherwise our setErrorHandler falls through
 *      to the 500 branch — that regression is the reason this lives in
 *      its own module).
 *   2. Span attribute stamping: rate_limit.* always; auth.untrusted.* only
 *      on token-body routes; nothing on routes whose body shape is unrelated.
 */

function makeMockSpan() {
  const setAttribute = vi.fn();
  return { setAttribute, calls: () => Object.fromEntries(setAttribute.mock.calls) };
}

const NOOP_REQUEST_FOR_RETURN_VALUE_TEST = {
  openTelemetry: () => ({ activeSpan: undefined }),
  body: null,
  routeOptions: { url: "/api/v1/auth/refresh" },
} as unknown as Parameters<typeof buildRateLimitError>[0];

describe("buildRateLimitError", () => {
  it("returns an actual Error instance with statusCode=429 and name=RateLimitError", () => {
    const err = buildRateLimitError(NOOP_REQUEST_FOR_RETURN_VALUE_TEST, { max: 30, ttl: 25_000 });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("RateLimitError");
    expect(err.message).toBe("Rate limit exceeded, retry in 25 seconds");
    expect((err as Error & { statusCode?: number }).statusCode).toBe(429);
  });
});

describe("stampRateLimitAttrs", () => {
  it("always stamps rate_limit.max + rate_limit.ttl_ms", () => {
    const span = makeMockSpan();
    stampRateLimitAttrs(
      span,
      { body: null, routeOptions: { url: "/api/v1/whatever" } } as Parameters<typeof stampRateLimitAttrs>[1],
      { max: 100, ttl: 60_000 },
    );
    expect(span.calls()).toEqual({ "rate_limit.max": 100, "rate_limit.ttl_ms": 60_000 });
  });

  it("decodes refreshToken on /api/v1/auth/refresh and stamps auth.untrusted.sub", async () => {
    const token = await new SignJWT({ sub: "user-zzz", type: "refresh" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(1_700_000_000)
      .setExpirationTime(9_999_999_999)
      .setJti("jti-rl")
      .sign(new TextEncoder().encode("anything"));
    const span = makeMockSpan();

    stampRateLimitAttrs(
      span,
      {
        body: { refreshToken: token },
        routeOptions: { url: "/api/v1/auth/refresh" },
      } as Parameters<typeof stampRateLimitAttrs>[1],
      { max: 30, ttl: 25_000 },
    );

    const attrs = span.calls();
    expect(attrs["auth.untrusted.sub"]).toBe("user-zzz");
    expect(attrs["auth.untrusted.jti"]).toBe("jti-rl");
    expect(attrs["auth.untrusted.type"]).toBe("refresh");
  });

  it("decodes connect-token body field `token` on /api/v1/auth/connect-token", async () => {
    const token = await new SignJWT({ sub: "user-cx", type: "connect" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode("k"));
    const span = makeMockSpan();

    stampRateLimitAttrs(
      span,
      {
        body: { token },
        routeOptions: { url: "/api/v1/auth/connect-token" },
      } as Parameters<typeof stampRateLimitAttrs>[1],
      { max: 5, ttl: 60_000 },
    );

    expect(span.calls()["auth.untrusted.sub"]).toBe("user-cx");
  });

  it("does NOT decode body on routes outside the auth allow-list, even if body has a token-shaped field", () => {
    // Regression for issue #246 review §2.4: a future POST /api/v1/foo with
    // body { token: "<opaque>" } must not get its 429 trace polluted with
    // bogus untrusted attrs.
    const span = makeMockSpan();
    stampRateLimitAttrs(
      span,
      {
        body: { token: "this.is.not.a.jwt.but.could.be.confused" },
        routeOptions: { url: "/api/v1/some-future-route" },
      } as Parameters<typeof stampRateLimitAttrs>[1],
      { max: 10, ttl: 60_000 },
    );

    const attrs = span.calls();
    expect(attrs["rate_limit.max"]).toBe(10);
    expect(Object.keys(attrs).some((k) => k.startsWith("auth."))) // no auth.* leakage
      .toBe(false);
  });

  it("does NOT stamp exception.type — that comes from setErrorHandler/recordException downstream", () => {
    // Regression for issue #246 review §2.5: builder used to also stamp
    // `exception.type=RateLimitError` which got overwritten anyway by
    // OTel's recordException(err) once setErrorHandler ran.
    const span = makeMockSpan();
    stampRateLimitAttrs(
      span,
      { body: null, routeOptions: { url: "/api/v1/auth/refresh" } } as Parameters<typeof stampRateLimitAttrs>[1],
      { max: 30, ttl: 25_000 },
    );
    expect("exception.type" in span.calls()).toBe(false);
  });

  it("is a no-op when the route is unknown (route-less request) — no body sniffing", () => {
    const span = makeMockSpan();
    stampRateLimitAttrs(
      span,
      { body: { refreshToken: "any" }, routeOptions: undefined } as unknown as Parameters<
        typeof stampRateLimitAttrs
      >[1],
      { max: 1, ttl: 1 },
    );
    const attrs = span.calls();
    expect(attrs["rate_limit.max"]).toBe(1);
    expect(Object.keys(attrs).some((k) => k.startsWith("auth."))).toBe(false);
  });
});
