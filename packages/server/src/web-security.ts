import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BROWSER_SECURITY_MANIFEST_FILENAME,
  BROWSER_SECURITY_MAX_MANIFEST_BYTES,
  type BrowserSecurityIntegration,
  type BrowserSecurityManifest,
  type BrowserSecuritySources,
  browserSecurityBuildIdSchema,
  browserSecurityManifestSchema,
  browserSecuritySourcesSchema,
  WEB_VERSION_MANIFEST_FILENAME,
} from "@first-tree/shared";
import { z } from "zod";
import type { Config } from "./config.js";

const MAX_VERSION_MANIFEST_BYTES = 4 * 1024;
const versionManifestSchema = z.object({ buildId: browserSecurityBuildIdSchema }).strict();

function readBoundedJson(path: string, maxBytes: number, label: string): unknown {
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size <= 0 || stats.size > maxBytes) throw new Error("invalid file size");
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error(`${label} is missing, unreadable, oversized, or invalid JSON.`);
  }
}

/**
 * Read and validate the two Vite-produced Web sidecars as one atomic contract.
 * Error text never includes file contents, parse errors, or rejected values.
 */
export function loadBrowserSecurityManifest(webDistPath: string): BrowserSecurityManifest {
  const webRoot = resolve(webDistPath);
  const manifestInput = readBoundedJson(
    join(webRoot, BROWSER_SECURITY_MANIFEST_FILENAME),
    BROWSER_SECURITY_MAX_MANIFEST_BYTES,
    "Embedded Web browser security manifest",
  );
  const manifestResult = browserSecurityManifestSchema.safeParse(manifestInput);
  if (!manifestResult.success) {
    throw new Error("Embedded Web browser security manifest failed schema validation.");
  }

  const versionInput = readBoundedJson(
    join(webRoot, WEB_VERSION_MANIFEST_FILENAME),
    MAX_VERSION_MANIFEST_BYTES,
    "Embedded Web version manifest",
  );
  const versionResult = versionManifestSchema.safeParse(versionInput);
  if (!versionResult.success) {
    throw new Error("Embedded Web version manifest failed schema validation.");
  }
  if (versionResult.data.buildId !== manifestResult.data.buildId) {
    throw new Error("Embedded Web browser security manifest build id does not match version.json.");
  }

  return manifestResult.data;
}

function exactPublicOriginUrl(publicUrl: string): URL {
  try {
    const parsed = new URL(publicUrl);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.pathname !== "/" ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0 ||
      parsed.origin !== publicUrl
    ) {
      throw new Error("not an exact origin");
    }
    return parsed;
  } catch {
    throw new Error(
      "FIRST_TREE_PUBLIC_URL must be a canonical exact HTTP(S) origin without credentials, path, query, or fragment.",
    );
  }
}

/** Derive the explicit same-origin WebSocket CSP source from publicUrl. */
export function webSocketOriginFromPublicUrl(publicUrl?: string): string | undefined {
  if (publicUrl === undefined) return undefined;
  const parsed = exactPublicOriginUrl(publicUrl);
  const scheme = parsed.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${parsed.host}`;
}

function integrationIsActive(integration: BrowserSecurityIntegration, hostname: string): boolean {
  return "allHosts" in integration.activation || integration.activation.hosts.includes(hostname);
}

function assertRuntimeOriginsValid(config: Config): BrowserSecuritySources {
  const sources = {
    script: config.security.csp.scriptOrigins,
    connect: config.security.csp.connectOrigins,
    image: config.security.csp.imageOrigins,
  };
  const result = browserSecuritySourcesSchema.safeParse(sources);
  if (!result.success) {
    throw new Error(
      "FIRST_TREE_CSP_*_ORIGINS must contain bounded, sorted, unique exact browser origins; connect additionally accepts WS(S).",
    );
  }
  if (process.env.NODE_ENV === "production") {
    const insecureHttpOrigin = [...result.data.script, ...result.data.image].some(
      (origin) => !origin.startsWith("https://"),
    );
    const insecureConnectOrigin = result.data.connect.some(
      (origin) => !origin.startsWith("https://") && !origin.startsWith("wss://"),
    );
    if (insecureHttpOrigin || insecureConnectOrigin) {
      throw new Error("FIRST_TREE_CSP_*_ORIGINS must use HTTPS or WSS origins in production.");
    }
  }
  return result.data;
}

function assertProductionManifestSchemes(manifest: BrowserSecurityManifest): void {
  if (process.env.NODE_ENV !== "production") return;
  for (const integration of manifest.integrations) {
    const insecureHttpOrigin = [...integration.required.script, ...integration.required.image].some(
      (origin) => !origin.startsWith("https://"),
    );
    const insecureConnectOrigin = integration.required.connect.some(
      (origin) => !origin.startsWith("https://") && !origin.startsWith("wss://"),
    );
    if (insecureHttpOrigin || insecureConnectOrigin) {
      throw new Error("Embedded Web browser security manifest must use HTTPS or WSS origins in production.");
    }
  }
}

function assertRequiredOriginsIncluded(
  manifest: BrowserSecurityManifest,
  hostname: string,
  configured: BrowserSecuritySources,
): void {
  for (const integration of manifest.integrations) {
    if (!integrationIsActive(integration, hostname)) continue;
    for (const capability of ["script", "connect", "image"] as const) {
      const configuredSet = new Set(configured[capability]);
      const missing = integration.required[capability].filter((origin) => !configuredSet.has(origin));
      if (missing.length > 0) {
        throw new Error(
          `Embedded Web CSP contract mismatch: integration ${integration.id} requires missing ${capability} origin(s): ${missing.join(", ")}.`,
        );
      }
    }
  }
}

/**
 * Fail closed for the embedded SPA before telemetry, migrations, or listen.
 * API-only processes still validate their configured CSP origin lists, but do
 * not require Web build sidecars.
 */
export function assertWebSecurityContract(config: Config): void {
  const configured = assertRuntimeOriginsValid(config);
  const configuredPublicUrl = config.server.publicUrl;
  const publicOrigin = configuredPublicUrl === undefined ? undefined : exactPublicOriginUrl(configuredPublicUrl);
  if (process.env.NODE_ENV === "production" && publicOrigin?.protocol !== "https:") {
    throw new Error(
      publicOrigin === undefined
        ? "FIRST_TREE_PUBLIC_URL is required in production."
        : "FIRST_TREE_PUBLIC_URL must use HTTPS in production.",
    );
  }

  if (config.webDistPath === undefined) return;
  if (config.webDistPath.trim().length === 0) {
    throw new Error("FIRST_TREE_WEB_DIST_PATH must not be blank when configured.");
  }
  if (publicOrigin === undefined) {
    throw new Error("FIRST_TREE_PUBLIC_URL is required when serving the embedded Web SPA.");
  }

  const manifest = loadBrowserSecurityManifest(config.webDistPath);
  assertProductionManifestSchemes(manifest);
  assertRequiredOriginsIncluded(manifest, publicOrigin.hostname, configured);
}
