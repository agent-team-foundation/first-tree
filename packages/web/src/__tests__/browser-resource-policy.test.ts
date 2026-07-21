import { describe, expect, it } from "vitest";
import {
  BROWSER_INTEGRATION_REGISTRY,
  buildBrowserSecurityManifest,
  CLARITY_COLLECTOR_ORIGINS,
  GOOGLE_ANALYTICS_INTEGRATION_ID,
  isBrowserIntegrationActive,
  MICROSOFT_CLARITY_INTEGRATION_ID,
  materializeBrowserSecuritySources,
  resolveEffectiveSentryIntegration,
  resolveViteBrowserEnvironment,
  WEB_SENTRY_INTEGRATION_ID,
} from "../browser-resource-policy.js";

function manifestIntegration(buildEnv: { VITE_SENTRY_DSN?: string; VITE_SENTRY_ENABLED?: string }, id: string) {
  return buildBrowserSecurityManifest("build-test", buildEnv).integrations.find((integration) => integration.id === id);
}

describe("browser integration registry", () => {
  it("uses one exact production-host activation for both analytics integrations", () => {
    expect(isBrowserIntegrationActive(BROWSER_INTEGRATION_REGISTRY.googleAnalytics, "cloud.first-tree.ai")).toBe(true);
    expect(isBrowserIntegrationActive(BROWSER_INTEGRATION_REGISTRY.microsoftClarity, "cloud.first-tree.ai")).toBe(true);
    expect(isBrowserIntegrationActive(BROWSER_INTEGRATION_REGISTRY.googleAnalytics, "dev.cloud.first-tree.ai")).toBe(
      false,
    );
    expect(isBrowserIntegrationActive(BROWSER_INTEGRATION_REGISTRY.microsoftClarity, "localhost")).toBe(false);
  });

  it("declares the corrected exact GA4 baseline sources", () => {
    expect(manifestIntegration({}, GOOGLE_ANALYTICS_INTEGRATION_ID)?.required).toEqual({
      script: ["https://www.googletagmanager.com"],
      connect: [
        "https://analytics.google.com",
        "https://region1.google-analytics.com",
        "https://www.google-analytics.com",
        "https://www.googletagmanager.com",
      ],
      image: [
        "https://region1.google-analytics.com",
        "https://www.google-analytics.com",
        "https://www.googletagmanager.com",
      ],
    });
  });

  it("enumerates Clarity's exact collectors without a wildcard", () => {
    expect(CLARITY_COLLECTOR_ORIGINS).toHaveLength(26);
    expect(CLARITY_COLLECTOR_ORIGINS[0]).toBe("https://a.clarity.ms");
    expect(CLARITY_COLLECTOR_ORIGINS[25]).toBe("https://z.clarity.ms");
    expect(manifestIntegration({}, MICROSOFT_CLARITY_INTEGRATION_ID)?.required).toEqual({
      script: ["https://www.clarity.ms"],
      connect: CLARITY_COLLECTOR_ORIGINS,
      image: ["https://c.bing.com", "https://c.clarity.ms"],
    });
  });

  it("keeps every inventory row exact and records requirement, initiator, and resource type", () => {
    for (const integration of Object.values(BROWSER_INTEGRATION_REGISTRY)) {
      for (const row of integration.rows) {
        expect(row.requirement === "required" || row.requirement === "conditional").toBe(true);
        expect(row.initiator.length).toBeGreaterThan(0);
        expect(row.resourceType.length).toBeGreaterThan(0);
        expect(row.origin).not.toContain("*");
        expect(new URL(row.origin).origin).toBe(row.origin);
      }
    }
    expect(BROWSER_INTEGRATION_REGISTRY.githubAvatar.rows[0]?.requirement).toBe("conditional");
    expect(BROWSER_INTEGRATION_REGISTRY.cloudflareBrowserInsights.rows[0]?.requirement).toBe("conditional");
    expect(BROWSER_INTEGRATION_REGISTRY.webSentry.dynamicRows[0]).toMatchObject({
      requirement: "required",
      capability: "connect",
      originFrom: "sentry-dsn",
      resourceType: "fetch-or-beacon",
    });
  });

  it("fails closed when a loader origin drifts from its required script row", () => {
    for (const integration of Object.values(BROWSER_INTEGRATION_REGISTRY)) {
      if (!("loaderUrl" in integration)) continue;
      expect(materializeBrowserSecuritySources(integration).script).toContain(new URL(integration.loaderUrl).origin);
    }

    expect(() =>
      materializeBrowserSecuritySources({
        ...BROWSER_INTEGRATION_REGISTRY.googleAnalytics,
        loaderUrl: "https://drifted-loader.example.test/gtag.js",
      }),
    ).toThrowError("must declare its loader origin as a required script");
  });

  it("materializes dynamic origins using the capability declared by the registry row", () => {
    const dynamicRow = BROWSER_INTEGRATION_REGISTRY.webSentry.dynamicRows[0];
    if (!dynamicRow) throw new Error("Sentry registry must declare its dynamic policy row");
    expect(
      materializeBrowserSecuritySources(
        {
          ...BROWSER_INTEGRATION_REGISTRY.webSentry,
          dynamicRows: [{ ...dynamicRow, capability: "image" }],
        },
        { "sentry-dsn": "https://capture.example.test" },
      ),
    ).toEqual({
      script: [],
      connect: [],
      image: ["https://capture.example.test"],
    });
  });
});

describe("effective Sentry build activation", () => {
  it("matches the browser client's enable and disable semantics", () => {
    expect(resolveEffectiveSentryIntegration({})).toEqual({ active: false });
    expect(resolveEffectiveSentryIntegration({ VITE_SENTRY_ENABLED: "true" })).toEqual({ active: false });
    expect(
      resolveEffectiveSentryIntegration({
        VITE_SENTRY_DSN: "https://public@example.ingest.sentry.io/42",
        VITE_SENTRY_ENABLED: "false",
      }),
    ).toEqual({ active: false });
    expect(
      resolveEffectiveSentryIntegration({ VITE_SENTRY_DSN: "https://public@example.ingest.sentry.io/42" }),
    ).toEqual({
      active: true,
      dsn: "https://public@example.ingest.sentry.io/42",
      origin: "https://example.ingest.sentry.io",
    });
  });

  it("emits only the active DSN origin in the sanitized manifest", () => {
    const manifest = buildBrowserSecurityManifest("sha-test", {
      VITE_SENTRY_DSN: "https://public@example.ingest.sentry.io/42?token=secret",
      VITE_SENTRY_ENABLED: "yes",
    });
    expect(manifestIntegration({}, WEB_SENTRY_INTEGRATION_ID)).toBeUndefined();
    expect(manifest.integrations.find((integration) => integration.id === WEB_SENTRY_INTEGRATION_ID)).toEqual({
      id: WEB_SENTRY_INTEGRATION_ID,
      activation: { allHosts: true },
      required: {
        script: [],
        connect: ["https://example.ingest.sentry.io"],
        image: [],
      },
    });
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain("public@");
    expect(serialized).not.toContain("/42");
    expect(serialized).not.toContain("token=secret");
  });

  it("fails malformed active DSNs without echoing their value", () => {
    const secretValue = "not-a-url-with-secret-routing";
    expect(() =>
      resolveEffectiveSentryIntegration({ VITE_SENTRY_DSN: secretValue, VITE_SENTRY_ENABLED: "true" }),
    ).toThrowError("VITE_SENTRY_DSN must be a valid HTTP(S) Sentry DSN");
    try {
      resolveEffectiveSentryIntegration({ VITE_SENTRY_DSN: secretValue, VITE_SENTRY_ENABLED: "true" });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(secretValue);
    }
  });
});

describe("Vite environment resolution", () => {
  it("gives the process VITE_ namespace precedence over env-file values", () => {
    expect(
      resolveViteBrowserEnvironment(
        {
          VITE_SENTRY_DSN: "https://file@example.ingest.sentry.io/1",
          VITE_SENTRY_ENABLED: "false",
          VITE_FILE_ONLY: "kept",
        },
        {
          VITE_SENTRY_DSN: "https://process@example.ingest.sentry.io/2",
          VITE_SENTRY_ENABLED: "true",
          VITE_PROCESS_ONLY: "added",
          SENTRY_AUTH_TOKEN: "not-browser-visible",
        },
      ),
    ).toEqual({
      VITE_SENTRY_DSN: "https://process@example.ingest.sentry.io/2",
      VITE_SENTRY_ENABLED: "true",
      VITE_FILE_ONLY: "kept",
      VITE_PROCESS_ONLY: "added",
    });
  });
});
