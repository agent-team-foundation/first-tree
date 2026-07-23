import Fastify, { type LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import {
  assertContentSecurityPolicySize,
  buildContentSecurityPolicyDirectives,
  MAX_CONTENT_SECURITY_POLICY_BYTES,
  PERMISSIONS_POLICY,
  registerSecurityHeaders,
  serializeContentSecurityPolicy,
} from "../security-headers.js";

function securityConfig({
  publicUrl,
  webDistPath,
  scriptOrigins = [],
  connectOrigins = [],
  imageOrigins = [],
}: {
  publicUrl?: string;
  webDistPath?: string;
  scriptOrigins?: string[];
  connectOrigins?: string[];
  imageOrigins?: string[];
} = {}): Config {
  return {
    server: { publicUrl },
    security: {
      csp: { scriptOrigins, connectOrigins, imageOrigins },
    },
    webDistPath,
  } as unknown as Config;
}

function expectSecurityContract(response: LightMyRequestResponse): void {
  expect(response.headers["content-security-policy-report-only"]).toBeUndefined();
  expect(response.headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(response.headers["permissions-policy"]).toBe(PERMISSIONS_POLICY);
  expect(response.headers["x-frame-options"]).toBe("DENY");

  const csp = response.headers["content-security-policy"];
  expect(csp).toBeTypeOf("string");
  if (typeof csp !== "string") throw new Error("missing Content-Security-Policy");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("script-src-attr 'none'");
  expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  expect(csp).not.toContain("'unsafe-eval'");
  expect(csp).not.toContain("upgrade-insecure-requests");
  expect(csp).not.toMatch(/(?:^|\s)\*(?:\s|;|$)/u);
  expect(csp).toBe(serializeContentSecurityPolicy(buildContentSecurityPolicyDirectives(securityConfig())));

  // These Helmet defaults are intentionally outside this issue's contract.
  expect(response.headers["cross-origin-embedder-policy"]).toBeUndefined();
  expect(response.headers["cross-origin-opener-policy"]).toBeUndefined();
  expect(response.headers["cross-origin-resource-policy"]).toBeUndefined();
  expect(response.headers["origin-agent-cluster"]).toBeUndefined();
  expect(response.headers["x-dns-prefetch-control"]).toBeUndefined();
  expect(response.headers["x-download-options"]).toBeUndefined();
  expect(response.headers["x-permitted-cross-domain-policies"]).toBeUndefined();
  expect(response.headers["x-xss-protection"]).toBeUndefined();
  expect(response.headers["x-powered-by"]).toBeUndefined();
}

describe("browser security headers", () => {
  it("builds the explicit least-privilege directive set with stable exact origins", () => {
    const directives = buildContentSecurityPolicyDirectives(
      securityConfig({
        publicUrl: "https://cloud.first-tree.ai",
        webDistPath: "/srv/web",
        scriptOrigins: ["https://www.clarity.ms", "https://www.googletagmanager.com", "https://www.clarity.ms"],
        connectOrigins: ["https://z.clarity.ms", "https://analytics.google.com"],
        imageOrigins: ["https://c.bing.com"],
      }),
    );

    expect(directives).toEqual({
      "default-src": ["'none'"],
      "base-uri": ["'none'"],
      "object-src": ["'none'"],
      "frame-ancestors": ["'none'"],
      "frame-src": ["'none'"],
      "child-src": ["'none'"],
      "form-action": ["'self'"],
      "script-src": ["'self'", "https://www.clarity.ms", "https://www.googletagmanager.com"],
      "script-src-attr": ["'none'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "style-src-elem": ["'self'"],
      "style-src-attr": ["'unsafe-inline'"],
      "font-src": ["'self'"],
      "img-src": ["'self'", "data:", "blob:", "https://c.bing.com"],
      "connect-src": ["'self'", "wss://cloud.first-tree.ai", "https://analytics.google.com", "https://z.clarity.ms"],
      "manifest-src": ["'self'"],
      "media-src": ["'none'"],
      "worker-src": ["'none'"],
    });

    const scriptSources = directives["script-src"] ?? [];
    expect(scriptSources).not.toContain("'unsafe-inline'");
    expect(scriptSources).not.toContain("'unsafe-eval'");
    expect(JSON.stringify(directives)).not.toContain("*");
    expect(directives).not.toHaveProperty("upgrade-insecure-requests");
  });

  it("derives ws:// for an HTTP embedded SPA and adds no socket origin in API-only mode", () => {
    expect(
      buildContentSecurityPolicyDirectives(
        securityConfig({ publicUrl: "http://localhost:3000", webDistPath: "/tmp/web" }),
      )["connect-src"],
    ).toEqual(["'self'", "ws://localhost:3000"]);

    expect(
      buildContentSecurityPolicyDirectives(securityConfig({ publicUrl: undefined, webDistPath: undefined }))[
        "connect-src"
      ],
    ).toEqual(["'self'"]);
  });

  it("serializes the policy deterministically in directive and source order", () => {
    expect(
      serializeContentSecurityPolicy({
        "default-src": ["'none'"],
        "script-src": ["'self'", "https://scripts.example"],
        "connect-src": ["'self'", "wss://app.example"],
      }),
    ).toBe("default-src 'none';script-src 'self' https://scripts.example;connect-src 'self' wss://app.example");
  });

  it("enforces one aggregate serialized-policy bound", () => {
    const small = securityConfig({ connectOrigins: ["https://api.example"] });
    expect(() => assertContentSecurityPolicySize(small)).not.toThrow();

    const connectOrigins = Array.from(
      { length: 128 },
      (_, index) => `https://${"a".repeat(52)}-${String(index).padStart(3, "0")}.example`,
    );
    const large = securityConfig({ connectOrigins });
    const serialized = serializeContentSecurityPolicy(buildContentSecurityPolicyDirectives(large));
    expect(Buffer.byteLength(serialized, "utf8")).toBeGreaterThan(MAX_CONTENT_SECURITY_POLICY_BYTES);
    expect(() => assertContentSecurityPolicySize(large)).toThrow(/Content-Security-Policy is too large/);
  });

  it("applies the same exact headers to success, error, OPTIONS, HEAD, and 304 responses", async () => {
    const app = Fastify();
    try {
      await registerSecurityHeaders(app, securityConfig());
      app.get("/ok", async () => ({ ok: true }));
      app.get("/error", async () => {
        throw new Error("expected test error");
      });
      app.options("/ok", async (_request, reply) => reply.status(204).send());
      app.get("/cached", async (request, reply) => {
        if (request.headers["if-none-match"] === '"security-contract"') {
          return reply.status(304).send();
        }
        return reply.header("ETag", '"security-contract"').send("cached");
      });
      await app.ready();

      const responses = await Promise.all([
        app.inject({ method: "GET", url: "/ok" }),
        app.inject({ method: "GET", url: "/error" }),
        app.inject({ method: "OPTIONS", url: "/ok" }),
        app.inject({ method: "HEAD", url: "/ok" }),
        app.inject({ method: "GET", url: "/cached", headers: { "if-none-match": '"security-contract"' } }),
      ]);
      expect(responses.map((response) => response.statusCode)).toEqual([200, 500, 204, 200, 304]);
      expect(responses[3]?.body).toBe("");
      for (const response of responses) expectSecurityContract(response);
    } finally {
      await app.close();
    }
  });
});
