import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserSecurityManifest } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import {
  assertWebSecurityContract,
  loadBrowserSecurityManifest,
  webSocketOriginFromPublicUrl,
} from "../web-security.js";

const tempDirs: string[] = [];

function validManifest(): BrowserSecurityManifest {
  return {
    schemaVersion: 1,
    buildId: "build-security-test",
    integrations: [
      {
        id: "ga4",
        activation: { hosts: ["cloud.first-tree.ai"] },
        required: {
          script: ["https://www.googletagmanager.com"],
          connect: ["https://analytics.google.com", "https://www.google-analytics.com"],
          image: ["https://www.google-analytics.com"],
        },
      },
      {
        id: "sentry",
        activation: { allHosts: true },
        required: {
          script: [],
          connect: ["https://o1.ingest.sentry.io"],
          image: [],
        },
      },
    ],
  };
}

function makeWebRoot(manifest: unknown = validManifest(), versionBuildId = "build-security-test"): string {
  const dir = mkdtempSync(join(tmpdir(), "first-tree-web-security-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "browser-security-manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "version.json"), JSON.stringify({ buildId: versionBuildId }));
  return dir;
}

function config(
  webDistPath: string | undefined,
  overrides: Partial<{
    publicUrl: string | undefined;
    scriptOrigins: string[];
    connectOrigins: string[];
    imageOrigins: string[];
  }> = {},
): Config {
  return {
    server: {
      publicUrl: "publicUrl" in overrides ? overrides.publicUrl : "https://cloud.first-tree.ai",
    },
    security: {
      csp: {
        scriptOrigins: overrides.scriptOrigins ?? ["https://www.googletagmanager.com"],
        connectOrigins: overrides.connectOrigins ?? [
          "https://analytics.google.com",
          "https://o1.ingest.sentry.io",
          "https://www.google-analytics.com",
        ],
        imageOrigins: overrides.imageOrigins ?? ["https://www.google-analytics.com"],
      },
    },
    webDistPath,
  } as unknown as Config;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadBrowserSecurityManifest", () => {
  it("loads a strict manifest only when the sibling build id matches", () => {
    const manifest = validManifest();
    expect(loadBrowserSecurityManifest(makeWebRoot(manifest))).toEqual(manifest);

    expect(() => loadBrowserSecurityManifest(makeWebRoot(manifest, "different-build"))).toThrow(
      /build id does not match version\.json/,
    );
  });

  it("fails closed on missing or malformed sidecars without reflecting their contents", () => {
    const missing = mkdtempSync(join(tmpdir(), "first-tree-web-security-missing-"));
    tempDirs.push(missing);
    expect(() => loadBrowserSecurityManifest(missing)).toThrow(/missing, unreadable, oversized, or invalid JSON/);

    const sensitive = "https://public-key:super-secret@example.ingest.sentry.io/123?token=secret";
    const root = makeWebRoot({ schemaVersion: 1, buildId: "build-security-test", integrations: [], dsn: sensitive });
    let message = "";
    try {
      loadBrowserSecurityManifest(root);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("failed schema validation");
    expect(message).not.toContain(sensitive);
    expect(message).not.toContain("super-secret");
  });
});

describe("embedded Web public origin", () => {
  it("derives the canonical WS(S) origin and preserves an explicit port", () => {
    expect(webSocketOriginFromPublicUrl(undefined)).toBeUndefined();
    expect(webSocketOriginFromPublicUrl("https://cloud.first-tree.ai")).toBe("wss://cloud.first-tree.ai");
    expect(webSocketOriginFromPublicUrl("https://cloud.first-tree.ai:8443")).toBe("wss://cloud.first-tree.ai:8443");
    expect(webSocketOriginFromPublicUrl("http://localhost:3000")).toBe("ws://localhost:3000");
  });

  it("rejects non-origin, credentialed, and non-canonical public URLs without reflecting them", () => {
    const invalid = [
      "https://cloud.first-tree.ai/",
      "https://cloud.first-tree.ai/app",
      "https://user:secret@cloud.first-tree.ai",
      "https://cloud.first-tree.ai?token=secret",
      "wss://cloud.first-tree.ai",
    ];
    for (const publicUrl of invalid) {
      let message = "";
      try {
        webSocketOriginFromPublicUrl(publicUrl);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("canonical exact HTTP(S) origin");
      expect(message).not.toContain(publicUrl);
    }
  });
});

describe("assertWebSecurityContract", () => {
  it("requires every active integration origin in its matching runtime capability", () => {
    const webRoot = makeWebRoot();
    expect(() => assertWebSecurityContract(config(webRoot))).not.toThrow();

    const wrongButNonempty = config(webRoot, {
      scriptOrigins: ["https://scripts.invalid"],
      connectOrigins: ["https://api.invalid", "https://events.invalid", "https://telemetry.invalid"],
      imageOrigins: ["https://images.invalid"],
    });
    expect(() => assertWebSecurityContract(wrongButNonempty)).toThrow(
      /integration ga4 requires missing script origin\(s\): https:\/\/www\.googletagmanager\.com/,
    );
  });

  it("does not accept a required origin under the wrong capability", () => {
    const webRoot = makeWebRoot();
    expect(() =>
      assertWebSecurityContract(
        config(webRoot, {
          scriptOrigins: [],
          connectOrigins: [
            "https://analytics.google.com",
            "https://o1.ingest.sentry.io",
            "https://www.google-analytics.com",
            "https://www.googletagmanager.com",
          ],
          imageOrigins: ["https://www.google-analytics.com"],
        }),
      ),
    ).toThrow(/integration ga4 requires missing script origin/);
  });

  it("rejects a missing active Clarity collector and a mismatched nonempty Sentry origin", () => {
    const manifest = validManifest();
    manifest.integrations.push({
      id: "clarity",
      activation: { hosts: ["cloud.first-tree.ai"] },
      required: {
        script: ["https://www.clarity.ms"],
        connect: ["https://z.clarity.ms"],
        image: ["https://c.bing.com"],
      },
    });
    const cloudRoot = makeWebRoot(manifest);
    expect(() =>
      assertWebSecurityContract(
        config(cloudRoot, {
          scriptOrigins: ["https://www.clarity.ms", "https://www.googletagmanager.com"],
          connectOrigins: [
            "https://analytics.google.com",
            "https://o1.ingest.sentry.io",
            "https://www.google-analytics.com",
          ],
          imageOrigins: ["https://c.bing.com", "https://www.google-analytics.com"],
        }),
      ),
    ).toThrow(/integration clarity requires missing connect origin\(s\): https:\/\/z\.clarity\.ms/);

    const stagingRoot = makeWebRoot();
    expect(() =>
      assertWebSecurityContract(
        config(stagingRoot, {
          publicUrl: "https://staging.first-tree.ai",
          scriptOrigins: [],
          connectOrigins: ["https://wrong.ingest.sentry.io"],
          imageOrigins: [],
        }),
      ),
    ).toThrow(/integration sentry requires missing connect origin\(s\): https:\/\/o1\.ingest\.sentry\.io/);
  });

  it("accepts sorted exact runtime supersets", () => {
    const webRoot = makeWebRoot();
    expect(() =>
      assertWebSecurityContract(
        config(webRoot, {
          scriptOrigins: ["https://cdn.example", "https://www.googletagmanager.com"],
          connectOrigins: [
            "https://analytics.google.com",
            "https://extra.example",
            "https://o1.ingest.sentry.io",
            "https://www.google-analytics.com",
          ],
          imageOrigins: ["https://images.example", "https://www.google-analytics.com"],
        }),
      ),
    ).not.toThrow();
  });

  it("uses hostname activation while retaining all-host build dependencies", () => {
    const webRoot = makeWebRoot();
    const nonCloud = config(webRoot, {
      publicUrl: "https://staging.first-tree.ai:8443",
      scriptOrigins: [],
      connectOrigins: ["https://o1.ingest.sentry.io"],
      imageOrigins: [],
    });
    expect(() => assertWebSecurityContract(nonCloud)).not.toThrow();

    expect(() =>
      assertWebSecurityContract(
        config(webRoot, {
          publicUrl: "https://staging.first-tree.ai",
          scriptOrigins: [],
          connectOrigins: [],
          imageOrigins: [],
        }),
      ),
    ).toThrow(/integration sentry requires missing connect origin/);
  });

  it("allows API-only startup without Web sidecars but still validates runtime origins", () => {
    expect(() =>
      assertWebSecurityContract(
        config(undefined, { publicUrl: undefined, scriptOrigins: [], connectOrigins: [], imageOrigins: [] }),
      ),
    ).not.toThrow();
    expect(() =>
      assertWebSecurityContract(
        config(undefined, {
          publicUrl: undefined,
          scriptOrigins: ["https://example.com/path"],
          connectOrigins: [],
          imageOrigins: [],
        }),
      ),
    ).toThrow(/bounded, sorted, unique exact browser origins/);
  });

  it("requires exact embedded public URL and HTTPS-only production sources", () => {
    const webRoot = makeWebRoot();
    expect(() =>
      assertWebSecurityContract(
        config(webRoot, { publicUrl: undefined, scriptOrigins: [], connectOrigins: [], imageOrigins: [] }),
      ),
    ).toThrow(/PUBLIC_URL is required when serving the embedded Web SPA/);

    vi.stubEnv("NODE_ENV", "production");
    expect(() =>
      assertWebSecurityContract(
        config(webRoot, {
          publicUrl: "http://cloud.first-tree.ai",
          scriptOrigins: [],
          connectOrigins: [],
          imageOrigins: [],
        }),
      ),
    ).toThrow(/must use HTTPS when serving the embedded Web SPA in production/);

    expect(() =>
      assertWebSecurityContract(
        config(undefined, {
          publicUrl: "https://cloud.first-tree.ai",
          scriptOrigins: ["http://scripts.example"],
          connectOrigins: [],
          imageOrigins: [],
        }),
      ),
    ).toThrow(/must use HTTPS or WSS origins in production/);

    expect(() =>
      assertWebSecurityContract(
        config(undefined, {
          publicUrl: "https://cloud.first-tree.ai",
          scriptOrigins: [],
          connectOrigins: ["https://api.example", "wss://socket.example"],
          imageOrigins: [],
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertWebSecurityContract(
        config(undefined, {
          publicUrl: "https://cloud.first-tree.ai",
          scriptOrigins: [],
          connectOrigins: ["ws://socket.example"],
          imageOrigins: [],
        }),
      ),
    ).toThrow(/must use HTTPS or WSS origins in production/);

    const insecureManifest = validManifest();
    insecureManifest.integrations.push({
      id: "conditional-edge",
      activation: { hosts: ["unused.example"] },
      required: { script: ["http://edge.example"], connect: [], image: [] },
    });
    const insecureRoot = makeWebRoot(insecureManifest);
    expect(() => assertWebSecurityContract(config(insecureRoot))).toThrow(/manifest must use HTTPS or WSS origins/);
  });
});
