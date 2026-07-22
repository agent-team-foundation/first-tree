import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { Config } from "../config.js";
import { buildCsp, isHtmlContentType } from "../middleware/security-headers.js";

/**
 * App-wide browser security headers (issue #1541).
 *
 * The onSend hook registered in `buildApp` must stamp the unconditional
 * header set on EVERY response class (static HTML, SPA fallback, assets,
 * API JSON, 404s, health checks), attach the CSP to `text/html` responses
 * only, and send HSTS only for https requests on a trusted proxy.
 *
 * Uses the same temp-webroot + `buildApp` + `inject` skeleton as
 * `build-app-validation.test.ts` — no seeded DB rows needed; the vitest
 * globalSetup Postgres is enough for `buildApp` to boot.
 */
const baseConfig: Config = {
  channel: "dev",
  growth: {
    landingPagesEnabled: false,
    landingCampaignMaxAgentTurns: 1,
    landingCampaignMaxEstimatedTokens: 120_000,
    landingCampaignMaxTrialsPerUserPer24Hours: 5,
  },
  docs: { enabled: false },
  database: { url: process.env.DATABASE_URL ?? "", provider: "external" },
  server: { port: 0, host: "127.0.0.1", publicUrl: undefined },
  workspace: { root: "/tmp/first-tree-test-workspaces" },
  secrets: {
    jwtSecret: "test-jwt-secret-key-for-vitest",
    encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  },
  auth: { accessTokenExpiry: "30m", refreshTokenExpiry: "30d", connectTokenExpiry: "10m" },
  trustProxy: false,
  connectBootstrap: {
    portableDownloadBaseUrl: "https://download.first-tree.ai/releases",
  },
  observability: { logging: { level: "error", format: "json", bridgeToSpanLevel: "off" } },
  runtime: {
    agentHttpTokenEnforcement: false,
    runtimeSwitchFaultInjection: false,
    pollingIntervalSeconds: 5,
    presenceCleanupSeconds: 60,
    archiveSweepIntervalSeconds: 0,
    archiveMappedIdleSeconds: 60 * 60,
    notificationWebhookUrl: undefined,
  },
  update: {
    commandVersion: "test.version",
    pollIntervalMinutes: 1440,
    registryUrl: "https://localhost.invalid",
  },
  instanceId: "test-instance",
};

/** Exact enforced subset delivered alongside the report-only policy. */
const ENFORCED_SUBSET = "frame-ancestors 'none'; object-src 'none'; base-uri 'self'";

/** The unconditional header set, asserted verbatim (full-string equality). */
function expectUnconditionalHeaders(headers: OutgoingHttpHeaders): void {
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["permissions-policy"]).toBe("camera=(), microphone=(), geolocation=()");
}

function expectNoCspHeaders(headers: OutgoingHttpHeaders): void {
  expect(headers["content-security-policy"]).toBeUndefined();
  expect(headers["content-security-policy-report-only"]).toBeUndefined();
}

describe("security headers — app-wide onSend hook", () => {
  let webRoot: string;

  beforeAll(async () => {
    webRoot = await mkdtemp(join(tmpdir(), "first-tree-sec-headers-"));
    await writeFile(join(webRoot, "index.html"), "<!doctype html><html><body>App shell</body></html>", "utf8");
    await mkdir(join(webRoot, "assets"), { recursive: true });
    await writeFile(join(webRoot, "assets", "app.js"), "console.log('asset');\n", "utf8");
  });

  afterAll(async () => {
    await rm(webRoot, { recursive: true, force: true });
  });

  describe("default mode — report-only CSP, no security config block", () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = await buildApp({ ...baseConfig, webDistPath: webRoot });
    });

    afterAll(async () => {
      await app.close();
    });

    it("stamps the header set and split CSP on the directly served index.html", async () => {
      const res = await app.inject({ method: "GET", url: "/" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expectUnconditionalHeaders(res.headers);
      // Enforced header carries EXACTLY the zero-risk subset while the full
      // policy rides report-only (frame-ancestors is spec-ignored in RO).
      expect(res.headers["content-security-policy"]).toBe(ENFORCED_SUBSET);
      expect(res.headers["content-security-policy-report-only"]).toBe(
        buildCsp({ cspMode: "report-only", hstsEnabled: true }),
      );
    });

    it("stamps the same headers on the SPA fallback response", async () => {
      const res = await app.inject({ method: "GET", url: "/workspace/deep-link" });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("App shell");
      expectUnconditionalHeaders(res.headers);
      expect(res.headers["content-security-policy"]).toBe(ENFORCED_SUBSET);
      expect(res.headers["content-security-policy-report-only"]).toBeDefined();
    });

    it("applies the header set WITHOUT CSP to static assets", async () => {
      const res = await app.inject({ method: "GET", url: "/assets/app.js" });
      expect(res.statusCode).toBe(200);
      expectUnconditionalHeaders(res.headers);
      expectNoCspHeaders(res.headers);
    });

    it("applies the header set WITHOUT CSP to API 404 JSON", async () => {
      const res = await app.inject({ method: "GET", url: "/api/missing" });
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toContain("application/json");
      expectUnconditionalHeaders(res.headers);
      expectNoCspHeaders(res.headers);
    });

    it("applies the header set WITHOUT CSP to a 200 API route (/healthz)", async () => {
      const res = await app.inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(200);
      expectUnconditionalHeaders(res.headers);
      expectNoCspHeaders(res.headers);
    });

    it("never sends HSTS when trustProxy=false, even for a spoofed x-forwarded-proto", async () => {
      // trustProxy=false means request.protocol ignores XFP — a client-forged
      // header must not conjure HSTS onto a plain-HTTP deployment.
      const spoofed = await app.inject({
        method: "GET",
        url: "/",
        headers: { "x-forwarded-proto": "https" },
      });
      expect(spoofed.headers["strict-transport-security"]).toBeUndefined();

      const plain = await app.inject({ method: "GET", url: "/" });
      expect(plain.headers["strict-transport-security"]).toBeUndefined();
    });
  });

  describe("enforce mode — trusted proxy, connect-src extras, report-uri", () => {
    let app: FastifyInstance;
    const security = {
      cspMode: "enforce" as const,
      cspConnectSrcExtra: "https://extra.example",
      cspReportUri: "https://report.example/csp",
      hstsEnabled: true,
    };

    beforeAll(async () => {
      app = await buildApp({ ...baseConfig, webDistPath: webRoot, trustProxy: true, security });
    });

    afterAll(async () => {
      await app.close();
    });

    it("sends the full policy enforced, with no report-only header", async () => {
      const res = await app.inject({ method: "GET", url: "/" });
      expect(res.statusCode).toBe(200);
      expectUnconditionalHeaders(res.headers);
      const csp = res.headers["content-security-policy"];
      expect(csp).toBe(buildCsp(security));
      expect(res.headers["content-security-policy-report-only"]).toBeUndefined();
      // Config plumbing: the operator-provided extra origin and report
      // endpoint must land in the wire policy.
      expect(csp).toContain("https://extra.example");
      expect(csp).toContain("report-uri https://report.example/csp");
    });

    it("sends HSTS exactly for https (x-forwarded-proto behind trustProxy)", async () => {
      const https = await app.inject({
        method: "GET",
        url: "/",
        headers: { "x-forwarded-proto": "https" },
      });
      expect(https.headers["strict-transport-security"]).toBe("max-age=31536000");

      const http = await app.inject({ method: "GET", url: "/" });
      expect(http.headers["strict-transport-security"]).toBeUndefined();
    });
  });

  describe("off mode — CSP escape hatch, HSTS disabled", () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = await buildApp({
        ...baseConfig,
        webDistPath: webRoot,
        trustProxy: true,
        security: { cspMode: "off", cspConnectSrcExtra: undefined, cspReportUri: undefined, hstsEnabled: false },
      });
    });

    afterAll(async () => {
      await app.close();
    });

    it("sends no CSP headers on HTML but keeps the unconditional set", async () => {
      const res = await app.inject({ method: "GET", url: "/" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expectUnconditionalHeaders(res.headers);
      expectNoCspHeaders(res.headers);
    });

    it("sends no HSTS on https when hstsEnabled=false", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/",
        headers: { "x-forwarded-proto": "https" },
      });
      expect(res.headers["strict-transport-security"]).toBeUndefined();
    });
  });
});

describe("buildCsp", () => {
  const defaults = { cspMode: "report-only" as const, hstsEnabled: true };

  function directive(csp: string, name: string): string {
    const match = csp.split("; ").find((d) => d.startsWith(`${name} `));
    expect(match, `directive ${name} present`).toBeDefined();
    return match ?? "";
  }

  it("emits the evidence-driven minimal policy", () => {
    const csp = buildCsp(defaults);
    expect(csp).toContain("default-src 'self'");
    expect(directive(csp, "img-src")).toBe("img-src 'self' data: blob: https:");
    expect(directive(csp, "style-src")).toBe("style-src 'self' 'unsafe-inline'");
    expect(directive(csp, "font-src")).toBe("font-src 'self'");
    expect(csp).toContain("manifest-src 'self'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("report-uri");
  });

  it("keeps script-src free of 'unsafe-inline' and redundant hosts", () => {
    const scriptSrc = directive(buildCsp(defaults), "script-src");
    expect(scriptSrc).toBe("script-src 'self' https://*.googletagmanager.com https://*.clarity.ms");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    // `https://*.clarity.ms` already matches www.clarity.ms — the explicit
    // host would be redundant.
    expect(scriptSrc).not.toContain("https://www.clarity.ms");
  });

  it("allowlists analytics + Sentry ingest in connect-src", () => {
    const connectSrc = directive(buildCsp(defaults), "connect-src");
    expect(connectSrc).toContain("'self'");
    expect(connectSrc).toContain("https://*.google-analytics.com");
    expect(connectSrc).toContain("https://*.analytics.google.com");
    expect(connectSrc).toContain("https://*.googletagmanager.com");
    expect(connectSrc).toContain("https://*.clarity.ms");
    expect(connectSrc).toContain("https://c.bing.com");
    expect(connectSrc).toContain("https://*.ingest.sentry.io");
    expect(connectSrc).toContain("https://*.ingest.us.sentry.io");
  });

  it("normalizes connect-src extras: commas, whitespace, semicolons, newlines", () => {
    const csp = buildCsp({
      ...defaults,
      cspConnectSrcExtra: "  https://a.example;,\n https://b.example ",
    });
    const connectSrc = directive(csp, "connect-src");
    expect(connectSrc.endsWith("https://a.example https://b.example")).toBe(true);
    // Directive-injection guard: no newline and no stray semicolon survives.
    expect(csp).not.toContain("\n");
    expect(csp).not.toContain(";;");
  });

  it("appends a sanitized report-uri as the final directive", () => {
    const csp = buildCsp({ ...defaults, cspReportUri: " https://r.example/csp;\n" });
    expect(csp.endsWith("; report-uri https://r.example/csp")).toBe(true);
  });

  it("drops a report-uri that is empty after sanitizing", () => {
    const csp = buildCsp({ ...defaults, cspReportUri: " ;\n " });
    expect(csp).not.toContain("report-uri");
  });
});

describe("isHtmlContentType", () => {
  it("accepts text/html with parameters and any casing", () => {
    expect(isHtmlContentType("text/html")).toBe(true);
    expect(isHtmlContentType("text/html; charset=utf-8")).toBe(true);
    expect(isHtmlContentType("TEXT/HTML; Charset=UTF-8")).toBe(true);
  });

  it("rejects non-HTML, unset, and non-string header values", () => {
    expect(isHtmlContentType("application/json; charset=utf-8")).toBe(false);
    expect(isHtmlContentType("text/plain")).toBe(false);
    expect(isHtmlContentType(undefined)).toBe(false);
    expect(isHtmlContentType(["text/html"])).toBe(false);
    expect(isHtmlContentType(42)).toBe(false);
  });
});
