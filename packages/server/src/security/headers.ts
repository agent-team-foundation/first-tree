import { DEFAULT_SECURITY_CSP } from "@first-tree/shared/config";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Config } from "../config.js";

type CspDirectiveName = keyof typeof DEFAULT_SECURITY_CSP;

export type SecurityCspConfig = {
  readonly [K in CspDirectiveName]: readonly string[];
};

export type SecurityHeaders = Readonly<Record<string, string>>;

type SecurityConfigInput = {
  readonly security?: {
    readonly csp?: Partial<SecurityCspConfig>;
  };
};

const HSTS_VALUE = "max-age=31536000; includeSubDomains";
const REFERRER_POLICY_VALUE = "strict-origin-when-cross-origin";
const PERMISSIONS_POLICY_VALUE = "camera=(), microphone=(), geolocation=(), payment=()";

const ORIGIN_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);
const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const CSP_DIRECTIVE_NAMES: readonly CspDirectiveName[] = [
  "scriptSrc",
  "connectSrc",
  "imgSrc",
  "fontSrc",
  "styleSrc",
  "frameSrc",
  "mediaSrc",
  "workerSrc",
  "formAction",
];

/**
 * Resolve the optional config group without weakening the safe defaults for
 * fields that were not explicitly overridden.
 */
export function resolveSecurityCspConfig(config: SecurityConfigInput): SecurityCspConfig {
  const configured = config.security?.csp;
  return {
    scriptSrc: configured?.scriptSrc ?? DEFAULT_SECURITY_CSP.scriptSrc,
    connectSrc: configured?.connectSrc ?? DEFAULT_SECURITY_CSP.connectSrc,
    imgSrc: configured?.imgSrc ?? DEFAULT_SECURITY_CSP.imgSrc,
    fontSrc: configured?.fontSrc ?? DEFAULT_SECURITY_CSP.fontSrc,
    styleSrc: configured?.styleSrc ?? DEFAULT_SECURITY_CSP.styleSrc,
    frameSrc: configured?.frameSrc ?? DEFAULT_SECURITY_CSP.frameSrc,
    mediaSrc: configured?.mediaSrc ?? DEFAULT_SECURITY_CSP.mediaSrc,
    workerSrc: configured?.workerSrc ?? DEFAULT_SECURITY_CSP.workerSrc,
    formAction: configured?.formAction ?? DEFAULT_SECURITY_CSP.formAction,
  };
}

/**
 * Build the complete enforced policy once per app instance. The policy is
 * intentionally deterministic so every SPA, API, health, and error response
 * exposes the same browser contract.
 */
export function buildSecurityHeaders(config: Pick<Config, "server"> & SecurityConfigInput): SecurityHeaders {
  const csp = resolveSecurityCspConfig(config);
  validateConfiguredSources(csp);

  const serverSources = resolveServerSources(config);
  const directives: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["default-src", ["'self'"]],
    ["base-uri", ["'self'"]],
    ["object-src", ["'none'"]],
    ["script-src", ["'self'", ...csp.scriptSrc]],
    ["style-src", ["'self'", "'unsafe-inline'", ...csp.styleSrc]],
    ["img-src", ["'self'", "data:", "blob:", ...csp.imgSrc]],
    ["font-src", ["'self'", "data:", ...csp.fontSrc]],
    ["connect-src", ["'self'", ...serverSources, ...csp.connectSrc]],
    ["frame-src", csp.frameSrc.length > 0 ? ["'self'", ...csp.frameSrc] : ["'none'"]],
    ["frame-ancestors", ["'none'"]],
    ["media-src", ["'self'", "blob:", ...csp.mediaSrc]],
    ["worker-src", ["'self'", "blob:", ...csp.workerSrc]],
    ["manifest-src", ["'self'"]],
    ["form-action", ["'self'", ...csp.formAction]],
  ];

  const contentSecurityPolicy = directives.map(([name, sources]) => `${name} ${unique(sources).join(" ")}`).join("; ");

  return {
    "Content-Security-Policy": contentSecurityPolicy,
    "Strict-Transport-Security": HSTS_VALUE,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": REFERRER_POLICY_VALUE,
    "Permissions-Policy": PERMISSIONS_POLICY_VALUE,
    "X-Frame-Options": "DENY",
  };
}

/**
 * Register the policy before any API or static-file plugin. Fastify executes
 * root `onRequest` hooks for route misses and SPA fallbacks as well, so the
 * headers cannot disappear on an error or deep-link response.
 */
export function registerSecurityHeaders(app: FastifyInstance, headers: SecurityHeaders): void {
  app.addHook("onRequest", (_request, reply, done) => {
    applySecurityHeaders(reply, headers);
    done();
  });
  app.addHook("onSend", (_request, reply, payload, done) => {
    // Re-apply at the last response hook so a route or plugin cannot weaken
    // the app-wide policy after the request hook has run.
    applySecurityHeaders(reply, headers);
    done(null, payload);
  });
}

export function applySecurityHeaders(reply: FastifyReply, headers: SecurityHeaders): void {
  for (const [name, value] of Object.entries(headers)) {
    reply.header(name, value);
  }
}

function validateConfiguredSources(config: SecurityCspConfig): void {
  for (const directive of CSP_DIRECTIVE_NAMES) {
    const sources = config[directive];
    for (const source of sources) {
      if (typeof source !== "string" || source.trim().length === 0) {
        throw new Error(`Invalid security.csp.${directive} source: expected a non-empty origin`);
      }
      const trimmed = source.trim();
      if (trimmed.includes("*") || trimmed.includes(";") || /\s/u.test(trimmed)) {
        throw new Error(
          `Invalid security.csp.${directive} source "${trimmed}": use an exact origin without wildcards or separators`,
        );
      }
      const parsed = parseOrigin(trimmed);
      if (!parsed) {
        throw new Error(
          `Invalid security.csp.${directive} source "${trimmed}": expected an exact HTTP(S) or WebSocket origin`,
        );
      }
      if (directive !== "connectSrc" && !HTTP_PROTOCOLS.has(parsed.protocol)) {
        throw new Error(
          `Invalid security.csp.${directive} source "${trimmed}": WebSocket origins are only allowed in connect-src`,
        );
      }
    }
  }
}

function resolveServerSources(config: Pick<Config, "server">): string[] {
  const serverUrl = parseServerOrigin(config.server.publicUrl);
  const fallback = serverUrl ?? parseLocalServerOrigin(config.server.host, config.server.port);
  if (!fallback) return [];
  const httpOrigin = `${fallback.protocol}//${fallback.host}`;
  const websocketProtocol = fallback.protocol === "https:" ? "wss:" : "ws:";
  return [httpOrigin, `${websocketProtocol}//${fallback.host}`];
}

function parseLocalServerOrigin(host: string, port: number): URL | undefined {
  const trimmedHost = host.trim();
  if (trimmedHost.length === 0) return undefined;
  const normalizedHost = trimmedHost.includes(":") && !trimmedHost.startsWith("[") ? `[${trimmedHost}]` : trimmedHost;
  try {
    return new URL(`http://${normalizedHost}:${port}`);
  } catch {
    return undefined;
  }
}

function parseOrigin(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (
      !ORIGIN_PROTOCOLS.has(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function parseServerOrigin(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (!HTTP_PROTOCOLS.has(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
