import helmet, { type FastifyHelmetOptions } from "@fastify/helmet";
import type { FastifyInstance } from "fastify";
import type { Config } from "./config.js";

export const PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), payment=()";

const CLOUD_PRODUCTION_HOST = "cloud.first-tree.ai";
export const CLOUD_PRODUCTION_CSP_ORIGINS = {
  scriptOrigins: [
    "https://www.googletagmanager.com",
    "https://www.clarity.ms",
    "https://scripts.clarity.ms",
    "https://static.cloudflareinsights.com",
  ],
  connectOrigins: [
    "https://www.google-analytics.com",
    "https://e.clarity.ms",
    "https://o4510502633209856.ingest.us.sentry.io",
  ],
  imageOrigins: [
    "https://avatars.githubusercontent.com",
    "https://lh3.googleusercontent.com",
    "https://c.clarity.ms",
    "https://c.bing.com",
  ],
} as const;

const EMPTY_CSP_ORIGINS = {
  scriptOrigins: [],
  connectOrigins: [],
  imageOrigins: [],
} as const;

function defaultCspOrigins(
  publicUrl: string | undefined,
): typeof CLOUD_PRODUCTION_CSP_ORIGINS | typeof EMPTY_CSP_ORIGINS {
  if (!publicUrl) return EMPTY_CSP_ORIGINS;
  return new URL(publicUrl).hostname === CLOUD_PRODUCTION_HOST ? CLOUD_PRODUCTION_CSP_ORIGINS : EMPTY_CSP_ORIGINS;
}

function websocketOrigin(publicUrl: string | undefined): string | undefined {
  if (!publicUrl) return undefined;
  const url = new URL(publicUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.origin;
}

export function buildHelmetOptions(config: Config): FastifyHelmetOptions {
  const configured = config.security?.csp;
  const defaults = defaultCspOrigins(config.server.publicUrl);
  const wsOrigin = websocketOrigin(config.server.publicUrl);

  return {
    global: true,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: [
          "'self'",
          ...(wsOrigin ? [wsOrigin] : []),
          ...(configured?.connectOrigins ?? defaults.connectOrigins),
        ],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        frameSrc: ["'none'"],
        imgSrc: ["'self'", "data:", "blob:", ...(configured?.imageOrigins ?? defaults.imageOrigins)],
        manifestSrc: ["'self'"],
        mediaSrc: ["'self'", "data:", "blob:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'", ...(configured?.scriptOrigins ?? defaults.scriptOrigins)],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        workerSrc: ["'self'", "blob:"],
      },
    },
    // Cross-origin isolation is explicitly outside this hardening change. It
    // needs its own compatibility pass before these headers can be enabled.
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
    xFrameOptions: { action: "deny" },
  };
}

export async function registerSecurityHeaders(app: FastifyInstance, config: Config): Promise<void> {
  await app.register(helmet, buildHelmetOptions(config));
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Permissions-Policy", PERMISSIONS_POLICY);
  });
}
