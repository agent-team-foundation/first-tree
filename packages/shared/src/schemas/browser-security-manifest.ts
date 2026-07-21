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
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu;
const IPV4_OCTET_PATTERN = /^(?:0|[1-9][0-9]{0,2})$/u;
const BRACKETED_IPV6_AUTHORITY_PATTERN = /^(\[[0-9a-f:.]+\])(?::([0-9]+))?$/iu;
const HOST_AUTHORITY_PATTERN = /^([^:]+)(?::([0-9]+))?$/u;

export interface BrowserSecurityAuthority {
  readonly hostname: string;
  readonly port: string;
}

function isCanonicalIpv4(hostname: string): boolean {
  const octets = hostname.split(".");
  return (
    octets.length === 4 && octets.every((octet) => IPV4_OCTET_PATTERN.test(octet) && Number.parseInt(octet, 10) <= 255)
  );
}

function isCanonicalDnsHostname(hostname: string): boolean {
  if (hostname.length > 253) return false;
  const labels = hostname.split(".");
  return labels.every((label) => DNS_LABEL_PATTERN.test(label));
}

function isCanonicalPort(port: string | undefined): boolean {
  if (port === undefined) return true;
  if (!/^[1-9][0-9]{0,4}$/u.test(port)) return false;
  return Number.parseInt(port, 10) <= 65_535;
}

/**
 * Parses the authority portion of a browser security origin without allowing
 * WHATWG URL normalization to reinterpret operator-controlled input. The
 * accepted grammar is deliberately limited to an ASCII DNS name (including
 * localhost and explicit punycode), canonical IPv4, or canonical bracketed
 * IPv6, plus an optional decimal TCP port.
 *
 * The returned hostname is lowercase and the absent port is represented by an
 * empty string. Scheme, path, credentials, query, fragment, CSP delimiters,
 * Unicode/IDNA input, legacy numeric IP forms, and non-canonical addresses are
 * rejected.
 */
export function parseBrowserSecurityAuthority(authority: string): BrowserSecurityAuthority | undefined {
  if (authority.length === 0 || [...authority].some((character) => character.charCodeAt(0) > 0x7f)) {
    return undefined;
  }

  const match = authority.startsWith("[")
    ? BRACKETED_IPV6_AUTHORITY_PATTERN.exec(authority)
    : HOST_AUTHORITY_PATTERN.exec(authority);
  const rawHostname = match?.[1];
  const rawPort = match?.[2];
  if (!rawHostname || !isCanonicalPort(rawPort)) return undefined;

  const lowercaseHostname = rawHostname.toLowerCase();
  if (rawHostname.startsWith("[")) {
    // The structural allowlist above excludes CSP delimiters, zone ids, and
    // every non-IPv6 hostname form. WHATWG is used only to validate and
    // canonicalize that bounded IPv6 grammar, never as the allowlist itself.
    try {
      const parsed = new URL(`http://${rawHostname}`);
      if (parsed.hostname !== lowercaseHostname) return undefined;
    } catch {
      return undefined;
    }
  } else {
    const numericHostname = /^[0-9.]+$/u.test(rawHostname);
    if (numericHostname ? !isCanonicalIpv4(rawHostname) : !isCanonicalDnsHostname(rawHostname)) {
      return undefined;
    }

    // Reject legacy/encoded numeric hosts and any other value WHATWG would
    // reinterpret even after it passes the conservative ASCII label grammar.
    try {
      const parsed = new URL(`http://${rawHostname}`);
      if (parsed.hostname !== lowercaseHostname) return undefined;
    } catch {
      return undefined;
    }
  }

  return { hostname: lowercaseHostname, port: rawPort ?? "" };
}

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
        const schemeSeparator = value.indexOf("://");
        if (schemeSeparator < 1) return false;
        const authority = parseBrowserSecurityAuthority(value.slice(schemeSeparator + 3));
        if (!authority) return false;
        const parsed = new URL(value);
        return (
          protocols.has(parsed.protocol) &&
          parsed.hostname === authority.hostname &&
          parsed.port === authority.port &&
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
    const authority = parseBrowserSecurityAuthority(value);
    return authority?.port === "" && authority.hostname === value;
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
