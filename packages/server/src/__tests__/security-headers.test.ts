import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildHelmetOptions, CLOUD_PRODUCTION_CSP_ORIGINS, PERMISSIONS_POLICY } from "../security-headers.js";
import { createTestApp } from "./helpers.js";

function cspDirective(header: string, name: string): string[] {
  const directive = header
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `));
  return directive?.split(/\s+/).slice(1) ?? [];
}

function expectSecurityHeaders(headers: Record<string, string | string[] | number | undefined>): void {
  expect(headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["permissions-policy"]).toBe(PERMISSIONS_POLICY);
  expect(headers["x-frame-options"]).toBe("DENY");

  const csp = headers["content-security-policy"];
  expect(typeof csp).toBe("string");
  if (typeof csp !== "string") throw new Error("Content-Security-Policy header missing");

  expect(cspDirective(csp, "default-src")).toEqual(["'self'"]);
  expect(cspDirective(csp, "frame-ancestors")).toEqual(["'none'"]);
  expect(cspDirective(csp, "script-src")).toEqual(["'self'", ...CLOUD_PRODUCTION_CSP_ORIGINS.scriptOrigins]);
  expect(cspDirective(csp, "script-src-attr")).toEqual(["'none'"]);
  expect(cspDirective(csp, "connect-src")).toEqual([
    "'self'",
    "wss://cloud.first-tree.ai",
    ...CLOUD_PRODUCTION_CSP_ORIGINS.connectOrigins,
  ]);
  expect(cspDirective(csp, "img-src")).toEqual([
    "'self'",
    "data:",
    "blob:",
    ...CLOUD_PRODUCTION_CSP_ORIGINS.imageOrigins,
  ]);
  expect(cspDirective(csp, "script-src")).not.toContain("'unsafe-inline'");
  expect(cspDirective(csp, "script-src")).not.toContain("'unsafe-eval'");
}

describe("app-wide browser security headers", () => {
  let app: FastifyInstance;
  let webRoot: string;

  beforeAll(async () => {
    webRoot = await mkdtemp(join(tmpdir(), "first-tree-security-headers-"));
    await writeFile(join(webRoot, "index.html"), "<!doctype html><html><body>App shell</body></html>", "utf8");
    app = await createTestApp({
      publicUrl: "https://cloud.first-tree.ai",
      webDistPath: webRoot,
    });
  });

  afterAll(async () => {
    await app?.close();
    await rm(webRoot, { recursive: true, force: true });
  });

  it("applies the enforced policy to SPA responses", async () => {
    const response = await app.inject({ method: "GET", url: "/workspace/deep-link" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("App shell");
    expectSecurityHeaders(response.headers);
  });

  it("applies the same policy to API responses", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(response.statusCode).toBe(200);
    expectSecurityHeaders(response.headers);
  });

  it("applies the same policy to API error responses", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/not-a-real-route" });
    expect(response.statusCode).toBe(404);
    expectSecurityHeaders(response.headers);
  });

  it("keeps non-production hosts self-only by default", () => {
    const options = buildHelmetOptions({
      ...app.config,
      server: { ...app.config.server, publicUrl: "https://dev.cloud.first-tree.ai" },
      security: undefined,
    });

    expect(options.contentSecurityPolicy).toMatchObject({
      directives: {
        scriptSrc: ["'self'"],
        connectSrc: ["'self'", "wss://dev.cloud.first-tree.ai"],
        imgSrc: ["'self'", "data:", "blob:"],
      },
    });
  });

  it("uses exact operator origins in place of production defaults", () => {
    const options = buildHelmetOptions({
      ...app.config,
      security: {
        csp: {
          scriptOrigins: ["https://scripts.example.test"],
          connectOrigins: ["https://api.example.test"],
          imageOrigins: ["https://images.example.test"],
        },
      },
    });

    expect(options.contentSecurityPolicy).toMatchObject({
      directives: {
        scriptSrc: ["'self'", "https://scripts.example.test"],
        connectSrc: ["'self'", "wss://cloud.first-tree.ai", "https://api.example.test"],
        imgSrc: ["'self'", "data:", "blob:", "https://images.example.test"],
      },
    });
  });
});
