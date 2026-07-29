import { DEFAULT_SECURITY_CSP } from "@first-tree/shared/config";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { buildSecurityHeaders, registerSecurityHeaders } from "../headers.js";

function directive(policy: string, name: string): string {
  const value = policy
    .split("; ")
    .find((entry) => entry.startsWith(`${name} `))
    ?.slice(name.length + 1);
  if (!value) throw new Error(`Missing CSP directive: ${name}`);
  return value;
}

function policyFrom(headers: Readonly<Record<string, string>>): string {
  const policy = headers["Content-Security-Policy"];
  if (!policy) throw new Error("Missing Content-Security-Policy header");
  return policy;
}

describe("browser security headers", () => {
  it("builds the complete enforced policy with same-origin WebSocket sources", () => {
    const headers = buildSecurityHeaders({
      server: {
        host: "127.0.0.1",
        port: 8000,
        publicUrl: "https://cloud.example.test",
      },
    });

    expect(headers).toMatchObject({
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
      "X-Frame-Options": "DENY",
    });

    const policy = policyFrom(headers);
    expect(directive(policy, "script-src")).toContain("'self'");
    expect(directive(policy, "script-src")).toContain("https://www.googletagmanager.com");
    expect(directive(policy, "script-src")).toContain("https://scripts.clarity.ms");
    expect(directive(policy, "script-src")).not.toMatch(/unsafe-(?:inline|eval)/u);
    expect(directive(policy, "connect-src")).toContain("https://cloud.example.test");
    expect(directive(policy, "connect-src")).toContain("https://a.clarity.ms");
    expect(directive(policy, "connect-src")).toContain("https://z.clarity.ms");
    expect(directive(policy, "connect-src")).toContain("wss://cloud.example.test");
    expect(directive(policy, "connect-src")).not.toContain("ws://cloud.example.test");
    expect(directive(policy, "img-src")).toContain("https://c.bing.com");
    expect(directive(policy, "img-src")).toContain("https://www.googletagmanager.com");
    expect(directive(policy, "frame-ancestors")).toBe("'none'");
    expect(directive(policy, "frame-src")).toBe("'none'");
  });

  it("uses configured origins without requiring a code change", () => {
    const headers = buildSecurityHeaders({
      server: {
        host: "127.0.0.1",
        port: 8000,
        publicUrl: undefined,
      },
      security: {
        csp: {
          ...DEFAULT_SECURITY_CSP,
          connectSrc: [...DEFAULT_SECURITY_CSP.connectSrc, "https://objects.example.test"],
          imgSrc: [...DEFAULT_SECURITY_CSP.imgSrc, "https://cdn.example.test"],
        },
      },
    });

    const policy = policyFrom(headers);
    expect(directive(policy, "connect-src")).toContain("ws://127.0.0.1:8000");
    expect(directive(policy, "connect-src")).not.toContain("wss://127.0.0.1:8000");
    expect(directive(policy, "connect-src")).toContain("https://objects.example.test");
    expect(directive(policy, "img-src")).toContain("https://cdn.example.test");
  });

  it("rejects wildcard or separator-bearing sources", () => {
    expect(() =>
      buildSecurityHeaders({
        server: { host: "127.0.0.1", port: 8000, publicUrl: undefined },
        security: {
          csp: {
            ...DEFAULT_SECURITY_CSP,
            scriptSrc: ["https://*.example.test"],
          },
        },
      }),
    ).toThrow(/exact origin/u);

    expect(() =>
      buildSecurityHeaders({
        server: { host: "127.0.0.1", port: 8000, publicUrl: undefined },
        security: {
          csp: {
            ...DEFAULT_SECURITY_CSP,
            connectSrc: ["https://example.test/path"],
          },
        },
      }),
    ).toThrow(/exact HTTP\(S\) or WebSocket origin/u);

    expect(() =>
      buildSecurityHeaders({
        server: { host: "127.0.0.1", port: 8000, publicUrl: undefined },
        security: {
          csp: {
            ...DEFAULT_SECURITY_CSP,
            scriptSrc: ["wss://cdn.example.test"],
          },
        },
      }),
    ).toThrow(/only allowed in connect-src/u);
  });

  it("keeps the configured server origin when publicUrl has a deployment path", () => {
    const headers = buildSecurityHeaders({
      server: {
        host: "127.0.0.1",
        port: 8000,
        publicUrl: "https://cloud.example.test/console",
      },
    });

    expect(directive(policyFrom(headers), "connect-src")).toContain("https://cloud.example.test");
  });

  it("re-applies the policy synchronously to a bodyless response", async () => {
    const app = Fastify();
    const headers = buildSecurityHeaders({
      server: {
        host: "127.0.0.1",
        port: 8000,
        publicUrl: "https://cloud.example.test",
      },
    });
    registerSecurityHeaders(app, headers);
    app.delete("/resource", (_request, reply) =>
      reply.header("Content-Security-Policy", "default-src *").code(204).send(),
    );

    try {
      const response = await app.inject({ method: "DELETE", url: "/resource" });
      expect(response.statusCode).toBe(204);
      expect(response.headers["content-security-policy"]).toBe(headers["Content-Security-Policy"]);
      expect(response.headers["strict-transport-security"]).toBe(headers["Strict-Transport-Security"]);
    } finally {
      await app.close();
    }
  });
});
