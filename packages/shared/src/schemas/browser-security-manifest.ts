import { z } from "zod";

export const BROWSER_SECURITY_MANIFEST_SCHEMA_VERSION = 1 as const;
export const BROWSER_SECURITY_MANIFEST_FILENAME = "browser-security-manifest.json";
export const WEB_VERSION_MANIFEST_FILENAME = "version.json";

export const BROWSER_SECURITY_MAX_BUILD_ID_LENGTH = 128;
export const BROWSER_SECURITY_MAX_INTEGRATIONS = 32;
export const BROWSER_SECURITY_MAX_INTEGRATION_ID_LENGTH = 64;
export const BROWSER_SECURITY_MAX_ACTIVATION_HOSTS = 32;
export const BROWSER_SECURITY_MAX_ORIGINS_PER_CAPABILITY = 128;
export const BROWSER_SECURITY_MAX_ORIGIN_LENGTH = 512;
export const BROWSER_SECURITY_MAX_MANIFEST_BYTES = 256 * 1024;

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const CONNECT_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

function isStrictlySortedUnique(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous === undefined || current === undefined || previous >= current) return false;
  }
  return true;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function exactOriginSchema(protocols: ReadonlySet<string>, message: string) {
  return z
    .string()
    .min(1)
    .max(BROWSER_SECURITY_MAX_ORIGIN_LENGTH)
    .refine((value) => {
      if (value.includes("*")) return false;
      try {
        const parsed = new URL(value);
        return (
          protocols.has(parsed.protocol) &&
          parsed.username.length === 0 &&
          parsed.password.length === 0 &&
          parsed.pathname === "/" &&
          parsed.search.length === 0 &&
          parsed.hash.length === 0 &&
          parsed.origin === value
        );
      } catch {
        return false;
      }
    }, message);
}

/**
 * Exact, canonical HTTP(S) origin accepted by script and image capabilities.
 * Paths, credentials, queries, fragments, wildcards, and non-canonical forms
 * are rejected so a manifest can never smuggle a full DSN or presigned URL.
 */
export const browserSecurityOriginSchema = exactOriginSchema(
  HTTP_PROTOCOLS,
  "must be a canonical exact HTTP(S) origin",
);

/** Exact HTTP(S)/WS(S) origin accepted by the connect capability. */
export const browserSecurityConnectOriginSchema = exactOriginSchema(
  CONNECT_PROTOCOLS,
  "must be a canonical exact HTTP(S) or WS(S) origin",
);

const activationHostSchema = z
  .string()
  .min(1)
  .max(253)
  .refine((value) => {
    if (value.includes("*") || value !== value.toLowerCase()) return false;
    if (/^\[[0-9a-f:.]+\]$/u.test(value)) return true;
    const labels = value.split(".");
    return labels.every(
      (label) => label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    );
  }, "must be a canonical exact hostname");

const activationHostsSchema = z
  .array(activationHostSchema)
  .min(1)
  .max(BROWSER_SECURITY_MAX_ACTIVATION_HOSTS)
  .refine(isStrictlySortedUnique, "activation hosts must be sorted and unique");

const httpOriginListSchema = z
  .array(browserSecurityOriginSchema)
  .max(BROWSER_SECURITY_MAX_ORIGINS_PER_CAPABILITY)
  .refine(isStrictlySortedUnique, "origins must be sorted and unique");

const connectOriginListSchema = z
  .array(browserSecurityConnectOriginSchema)
  .max(BROWSER_SECURITY_MAX_ORIGINS_PER_CAPABILITY)
  .refine(isStrictlySortedUnique, "origins must be sorted and unique");

export const browserSecuritySourcesSchema = z
  .object({
    script: httpOriginListSchema,
    connect: connectOriginListSchema,
    image: httpOriginListSchema,
  })
  .strict();

export const browserSecurityActivationSchema = z.union([
  z.object({ allHosts: z.literal(true) }).strict(),
  z.object({ hosts: activationHostsSchema }).strict(),
]);

export const browserSecurityIntegrationSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(BROWSER_SECURITY_MAX_INTEGRATION_ID_LENGTH)
      .regex(/^[a-z][a-z0-9-]*$/u, "must be a canonical integration id"),
    activation: browserSecurityActivationSchema,
    required: browserSecuritySourcesSchema,
  })
  .strict();

export const browserSecurityBuildIdSchema = z
  .string()
  .min(1)
  .max(BROWSER_SECURITY_MAX_BUILD_ID_LENGTH)
  .refine((value) => value === value.trim() && !hasControlCharacter(value), "must be a bounded canonical build id");

export const browserSecurityManifestSchema = z
  .object({
    schemaVersion: z.literal(BROWSER_SECURITY_MANIFEST_SCHEMA_VERSION),
    buildId: browserSecurityBuildIdSchema,
    integrations: z.array(browserSecurityIntegrationSchema).max(BROWSER_SECURITY_MAX_INTEGRATIONS),
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    for (const [index, integration] of manifest.integrations.entries()) {
      if (ids.has(integration.id)) {
        context.addIssue({
          code: "custom",
          message: "integration ids must be unique",
          path: ["integrations", index, "id"],
        });
      }
      ids.add(integration.id);
    }
  });

export type BrowserSecuritySources = z.infer<typeof browserSecuritySourcesSchema>;
export type BrowserSecurityActivation = z.infer<typeof browserSecurityActivationSchema>;
export type BrowserSecurityIntegration = z.infer<typeof browserSecurityIntegrationSchema>;
export type BrowserSecurityManifest = z.infer<typeof browserSecurityManifestSchema>;
