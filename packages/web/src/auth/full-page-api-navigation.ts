import { useEffect, useState } from "react";
import {
  canonicalizeServerAuthority,
  getPinnedServerTransportObservation,
  ServerAuthorityError,
  type ServerAuthorityObservation,
} from "../api/server-authority.js";

export const VITE_NAVIGATION_PROOF_QUERY_KEY = "ft_vite_nav";
export const VITE_NAVIGATION_PROOF_VERSION = "v1";

const VITE_GENERATION_PATTERN = /^[a-f0-9]{32}$/u;
const SAFE_QUERY_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const MAX_UNBOUND_TARGET_BYTES = 4_096;
const MAX_BOUND_TARGET_BYTES = 8_192;

const PROTECTED_NAVIGATION_QUERY_KEYS = new Map<string, ReadonlySet<string>>([
  ["/api/v1/auth/github/start", new Set(["next"])],
  ["/api/v1/auth/google/start", new Set(["next"])],
  [
    "/api/v1/auth/github/dev-callback",
    new Set([
      "githubId",
      "login",
      "email",
      "displayName",
      "next",
      "installationId",
      "installationAccountType",
      "installationAccountLogin",
      "installationAccountGithubId",
    ]),
  ],
]);

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function encodeBase64UrlUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function validateUnboundTarget(rawTarget: string): void {
  if (
    rawTarget.length === 0 ||
    byteLength(rawTarget) > MAX_UNBOUND_TARGET_BYTES ||
    rawTarget.includes("#") ||
    rawTarget.startsWith("//")
  ) {
    throw new ServerAuthorityError("Full-page API navigation target is invalid");
  }
  const queryIndex = rawTarget.indexOf("?");
  const pathname = queryIndex < 0 ? rawTarget : rawTarget.slice(0, queryIndex);
  const rawQuery = queryIndex < 0 ? "" : rawTarget.slice(queryIndex + 1);
  const allowedKeys = PROTECTED_NAVIGATION_QUERY_KEYS.get(pathname);
  if (!allowedKeys) throw new ServerAuthorityError("Full-page API navigation target is not allowed");
  if (rawQuery.length === 0) return;

  const seen = new Set<string>();
  for (const field of rawQuery.split("&")) {
    if (field.length === 0) throw new ServerAuthorityError("Full-page API navigation query is invalid");
    const equals = field.indexOf("=");
    const key = equals < 0 ? field : field.slice(0, equals);
    if (!SAFE_QUERY_KEY_PATTERN.test(key) || !allowedKeys.has(key) || seen.has(key)) {
      throw new ServerAuthorityError("Full-page API navigation query is invalid");
    }
    seen.add(key);
  }
}

export function buildViteNavigationProof(observation: ServerAuthorityObservation): string | null {
  const authority = canonicalizeServerAuthority(observation.authority);
  if (observation.viteGeneration === null) return null;
  if (!VITE_GENERATION_PATTERN.test(observation.viteGeneration)) {
    throw new ServerAuthorityError("Vite navigation generation is invalid");
  }
  return `${VITE_NAVIGATION_PROOF_VERSION}.${observation.viteGeneration}.${encodeBase64UrlUtf8(authority)}`;
}

/**
 * Bind one exact browser navigation to the document's verified Vite process
 * and server. Production has no Vite generation and therefore keeps the
 * original relative target unchanged.
 */
export function bindFullPageApiNavigation(rawTarget: string, observation: ServerAuthorityObservation): string {
  validateUnboundTarget(rawTarget);
  const proof = buildViteNavigationProof(observation);
  if (proof === null) return rawTarget;
  const separator = rawTarget.includes("?") ? "&" : "?";
  const bound = `${rawTarget}${separator}${VITE_NAVIGATION_PROOF_QUERY_KEY}=${proof}`;
  if (byteLength(bound) > MAX_BOUND_TARGET_BYTES) {
    throw new ServerAuthorityError("Full-page API navigation target is oversized");
  }
  return bound;
}

export async function prepareFullPageApiNavigation(rawTarget: string): Promise<string> {
  const observation = await getPinnedServerTransportObservation();
  return bindFullPageApiNavigation(rawTarget, observation);
}

/**
 * Prepare an anchor target without ever exposing the unbound API path as a
 * clickable fallback. A changed target invalidates the prior result
 * synchronously; a late promise cannot reinstall it.
 */
export function usePreparedFullPageApiNavigation(rawTarget: string | null): string | null {
  const [prepared, setPrepared] = useState<Readonly<{ source: string; target: string }> | null>(null);
  useEffect(() => {
    if (rawTarget === null) return;
    let live = true;
    void prepareFullPageApiNavigation(rawTarget)
      .then((target) => {
        if (live) setPrepared(Object.freeze({ source: rawTarget, target }));
      })
      .catch(() => {
        if (live) setPrepared(null);
      });
    return () => {
      live = false;
    };
  }, [rawTarget]);
  return prepared?.source === rawTarget ? prepared.target : null;
}
