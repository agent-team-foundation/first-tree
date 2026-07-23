import fastifyHelmet from "@fastify/helmet";
import type { FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import { webSocketOriginFromPublicUrl } from "./web-security.js";

export const PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), payment=()";

/**
 * Keep the enforced policy comfortably below common proxy/header-buffer
 * limits. The manifest schema bounds every individual list; this aggregate
 * bound prevents many otherwise-valid integrations from producing an
 * oversized response header when their requirements are combined.
 */
export const MAX_CONTENT_SECURITY_POLICY_BYTES = 8 * 1024;

export type ContentSecurityPolicyDirectives = Readonly<Record<string, readonly string[]>>;

function exactSources(fixed: readonly string[], configured: readonly string[]): string[] {
  const dynamic = [...new Set(configured)].sort();
  return [...fixed, ...dynamic.filter((source) => !fixed.includes(source))];
}

/** Build the sole app-wide CSP directive map from typed runtime config. */
export function buildContentSecurityPolicyDirectives(config: Config): ContentSecurityPolicyDirectives {
  const websocketOrigin = config.webDistPath ? webSocketOriginFromPublicUrl(config.server.publicUrl) : undefined;

  return {
    "default-src": ["'none'"],
    "base-uri": ["'none'"],
    "object-src": ["'none'"],
    "frame-ancestors": ["'none'"],
    "frame-src": ["'none'"],
    "child-src": ["'none'"],
    "form-action": ["'self'"],
    "script-src": exactSources(["'self'"], config.security.csp.scriptOrigins),
    "script-src-attr": ["'none'"],
    // React still uses style attributes throughout the existing UI. CSP3
    // browsers receive the narrow attribute exception below; style-src keeps
    // the same fallback for older implementations while style elements stay
    // same-origin only.
    "style-src": ["'self'", "'unsafe-inline'"],
    "style-src-elem": ["'self'"],
    "style-src-attr": ["'unsafe-inline'"],
    "font-src": ["'self'"],
    "img-src": exactSources(["'self'", "data:", "blob:"], config.security.csp.imageOrigins),
    "connect-src": exactSources(
      websocketOrigin ? ["'self'", websocketOrigin] : ["'self'"],
      config.security.csp.connectOrigins,
    ),
    "manifest-src": ["'self'"],
    "media-src": ["'none'"],
    "worker-src": ["'none'"],
  };
}

/** Serialize exactly the directive/value ordering passed to Helmet. */
export function serializeContentSecurityPolicy(directives: ContentSecurityPolicyDirectives): string {
  return Object.entries(directives)
    .map(([directive, sources]) => `${directive} ${sources.join(" ")}`)
    .join(";");
}

/** Fail at boot rather than emit a CSP that a proxy may truncate or reject. */
export function assertContentSecurityPolicySize(config: Config): void {
  const serialized = serializeContentSecurityPolicy(buildContentSecurityPolicyDirectives(config));
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_CONTENT_SECURITY_POLICY_BYTES) {
    throw new Error(
      `Content-Security-Policy is too large (${bytes} bytes; maximum ${MAX_CONTENT_SECURITY_POLICY_BYTES}). ` +
        "Reduce the configured exact-origin allowlists.",
    );
  }
}

/** Register the application-wide browser security contract before any route. */
export async function registerSecurityHeaders(app: FastifyInstance, config: Config): Promise<void> {
  const directives = buildContentSecurityPolicyDirectives(config);
  assertContentSecurityPolicySize(config);

  await app.register(fastifyHelmet, {
    global: true,
    enableCSPNonces: false,
    contentSecurityPolicy: {
      useDefaults: false,
      reportOnly: false,
      directives,
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
    originAgentCluster: false,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    strictTransportSecurity: {
      maxAge: 31_536_000,
      includeSubDomains: true,
      preload: false,
    },
    xContentTypeOptions: true,
    xDnsPrefetchControl: false,
    xDownloadOptions: false,
    xFrameOptions: { action: "deny" },
    xPermittedCrossDomainPolicies: false,
    xPoweredBy: false,
    xXssProtection: false,
  });

  // Helmet intentionally has no Permissions-Policy middleware. A root hook
  // keeps this header on normal, error, early preflight, HEAD, and 304 replies.
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Permissions-Policy", PERMISSIONS_POLICY);
  });
}
