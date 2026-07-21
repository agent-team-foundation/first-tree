import { describe, expect, it } from "vitest";
import {
  BROWSER_SECURITY_MAX_ACTIVATION_HOSTS,
  BROWSER_SECURITY_MAX_INTEGRATIONS,
  BROWSER_SECURITY_MAX_ORIGINS_PER_CAPABILITY,
  browserSecurityConnectOriginSchema,
  browserSecurityManifestSchema,
  browserSecurityOriginSchema,
} from "../schemas/browser-security-manifest.js";

function integration(id = "ga4") {
  return {
    id,
    activation: { hosts: ["cloud.first-tree.ai"] },
    required: {
      script: ["https://www.googletagmanager.com"],
      connect: ["https://analytics.google.com", "https://www.google-analytics.com"],
      image: [],
    },
  };
}

describe("browserSecurityManifestSchema", () => {
  it("accepts the strict version-1 contract", () => {
    expect(
      browserSecurityManifestSchema.parse({
        schemaVersion: 1,
        buildId: "0123456789abcdef",
        integrations: [integration(), { ...integration("sentry"), activation: { allHosts: true } }],
      }),
    ).toEqual({
      schemaVersion: 1,
      buildId: "0123456789abcdef",
      integrations: [integration(), { ...integration("sentry"), activation: { allHosts: true } }],
    });
  });

  it("rejects unknown fields and any source capability other than script/connect/image", () => {
    expect(
      browserSecurityManifestSchema.safeParse({
        schemaVersion: 1,
        buildId: "build-1",
        integrations: [{ ...integration(), dsn: "redacted" }],
      }).success,
    ).toBe(false);
    expect(
      browserSecurityManifestSchema.safeParse({
        schemaVersion: 1,
        buildId: "build-1",
        integrations: [
          {
            ...integration(),
            required: { ...integration().required, frame: ["https://example.com"] },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate integration ids and unsorted or duplicate arrays", () => {
    expect(
      browserSecurityManifestSchema.safeParse({
        schemaVersion: 1,
        buildId: "build-1",
        integrations: [integration(), integration()],
      }).success,
    ).toBe(false);
    expect(
      browserSecurityManifestSchema.safeParse({
        schemaVersion: 1,
        buildId: "build-1",
        integrations: [
          {
            ...integration(),
            activation: { hosts: ["z.example", "a.example"] },
            required: {
              ...integration().required,
              connect: ["https://z.example", "https://a.example"],
            },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects wildcard, credentialed, path, query, fragment, and non-canonical origins", () => {
    const invalid = [
      "https://*.example.com",
      "https://user:password@example.com",
      "https://example.com/path",
      "https://example.com?token=secret",
      "https://example.com#fragment",
      "https://example.com/",
      "https://example.com:443",
      "wss://example.com",
    ];
    for (const origin of invalid) {
      expect(browserSecurityOriginSchema.safeParse(origin).success).toBe(false);
    }
    expect(browserSecurityConnectOriginSchema.safeParse("wss://socket.example").success).toBe(true);
    expect(browserSecurityConnectOriginSchema.safeParse("ws://socket.example").success).toBe(true);
    expect(browserSecurityConnectOriginSchema.safeParse("wss://socket.example/").success).toBe(false);
  });

  it("enforces conservative integration, host, and per-capability bounds", () => {
    expect(
      browserSecurityManifestSchema.safeParse({
        schemaVersion: 1,
        buildId: "build-1",
        integrations: Array.from({ length: BROWSER_SECURITY_MAX_INTEGRATIONS + 1 }, (_, index) =>
          integration(`vendor-${index}`),
        ),
      }).success,
    ).toBe(false);

    const tooManyHosts = Array.from(
      { length: BROWSER_SECURITY_MAX_ACTIVATION_HOSTS + 1 },
      (_, index) => `host-${String(index).padStart(2, "0")}.example`,
    );
    expect(
      browserSecurityManifestSchema.safeParse({
        schemaVersion: 1,
        buildId: "build-1",
        integrations: [{ ...integration(), activation: { hosts: tooManyHosts } }],
      }).success,
    ).toBe(false);

    const tooManyOrigins = Array.from(
      { length: BROWSER_SECURITY_MAX_ORIGINS_PER_CAPABILITY + 1 },
      (_, index) => `https://host-${String(index).padStart(3, "0")}.example`,
    );
    expect(
      browserSecurityManifestSchema.safeParse({
        schemaVersion: 1,
        buildId: "build-1",
        integrations: [
          {
            ...integration(),
            required: { ...integration().required, connect: tooManyOrigins },
          },
        ],
      }).success,
    ).toBe(false);
  });
});
