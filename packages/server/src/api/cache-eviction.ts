import type { FastifyInstance, FastifyRequest } from "fastify";
import { configuredServerAuthority } from "../utils/server-authority.js";

const CACHE_EVICTION_HEADER = "x-first-tree-cache-eviction";

export async function cacheEvictionRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/cache-eviction", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (singleHeader(request, CACHE_EVICTION_HEADER) !== "1") {
      return reply.status(403).send({ error: "Cache eviction request rejected" });
    }
    if (hasCredentialAuthority(request)) {
      return reply.status(403).send({ error: "Cache eviction request must be credential-free" });
    }
    if (!isAllowedBrowserOrigin(app, request)) {
      return reply.status(403).send({ error: "Cache eviction request must be same-origin" });
    }

    reply.header("Clear-Site-Data", '"cache"');
    return reply.status(204).send();
  });
}

function hasCredentialAuthority(request: FastifyRequest): boolean {
  return (
    request.headers.authorization !== undefined ||
    request.headers["proxy-authorization"] !== undefined ||
    request.body !== undefined
  );
}

function singleHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? undefined : value;
}

function isAllowedBrowserOrigin(app: FastifyInstance, request: FastifyRequest): boolean {
  const fetchSite = singleHeader(request, "sec-fetch-site");
  if (fetchSite !== undefined && fetchSite !== "same-origin") return false;

  const origin = singleHeader(request, "origin");
  if (!origin) return fetchSite === "same-origin";
  let canonicalOrigin: string;
  try {
    canonicalOrigin = new URL(origin).origin;
  } catch {
    return false;
  }
  if (canonicalOrigin !== origin) return false;

  const parsedOrigin = new URL(canonicalOrigin);
  const isViteLoopbackOrigin =
    fetchSite === "same-origin" &&
    parsedOrigin.protocol === "http:" &&
    parsedOrigin.hostname === "127.0.0.1" &&
    parsedOrigin.port !== "";
  if (isViteLoopbackOrigin) return true;

  const allowed = new Set<string>();
  allowed.add(new URL(configuredServerAuthority(app.config)).origin);
  if (app.config.server.publicUrl) {
    try {
      allowed.add(new URL(app.config.server.publicUrl).origin);
    } catch {
      return false;
    }
  }
  for (const configured of app.config.cors?.origin?.split(",") ?? []) {
    try {
      allowed.add(new URL(configured.trim()).origin);
    } catch {
      return false;
    }
  }
  return allowed.has(origin);
}
