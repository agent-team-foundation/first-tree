import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../auth/auth-context.js";

/**
 * Poll cadence for the deployed-version check. 10 minutes surfaces a deploy
 * within a short break without adding meaningful load — the request is a
 * single tiny static JSON.
 */
const VERSION_POLL_MS = 10 * 60 * 1000;

/**
 * Build manifest emitted by Vite at build time (see vite.config.ts), served
 * as a static file alongside the SPA, so a fresh GET always reflects the
 * *currently deployed* build.
 */
const VERSION_MANIFEST_PATH = "/version.json";

/**
 * Narrow a parsed version manifest to its `buildId` without an `as` cast.
 * Returns null for any unrecognised shape so a malformed/missing manifest
 * reads as "no new version" rather than throwing.
 */
export function extractBuildId(data: unknown): string | null {
  if (typeof data === "object" && data !== null && "buildId" in data) {
    const { buildId } = data;
    if (typeof buildId === "string" && buildId.length > 0) return buildId;
  }
  return null;
}

/**
 * True when the deployed build differs from the one this tab is running. A
 * null deployed id (manifest missing — e.g. `vite dev`, or a fetch error) is
 * treated as "no new version" so the chip never shows spuriously.
 */
export function isNewVersionAvailable(deployedBuildId: string | null, runningBuildId: string): boolean {
  if (!deployedBuildId) return false;
  return deployedBuildId !== runningBuildId;
}

async function fetchDeployedBuildId(): Promise<string | null> {
  // Cache-bust + no-store so a long-lived tab never reads a stale manifest out
  // of the HTTP cache; the static server may otherwise attach caching headers.
  const res = await fetch(`${VERSION_MANIFEST_PATH}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) return null;
  try {
    const data: unknown = await res.json();
    return extractBuildId(data);
  } catch {
    // Non-JSON body (e.g. dev server SPA fallback returning index.html) — treat
    // as no manifest.
    return null;
  }
}

/**
 * Polls the deployed build manifest and reports whether the server is now
 * serving a newer web build than this tab loaded. The query refetches on mount
 * (so a freshly opened/reloaded tab checks immediately), every 10 minutes, and
 * when the tab regains focus. Gated on an authenticated user so it only runs
 * inside the app shell.
 */
export function useNewVersionAvailable(): boolean {
  const { user } = useAuth();
  const { data } = useQuery({
    queryKey: ["web-version"],
    queryFn: fetchDeployedBuildId,
    enabled: Boolean(user),
    refetchInterval: VERSION_POLL_MS,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
  return isNewVersionAvailable(data ?? null, __WEB_BUILD_ID__);
}
