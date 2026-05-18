/**
 * Single source of truth for the GitHub REST API base URL.
 *
 * Reads `FIRST_TREE_HUB_GITHUB_API_BASE_URL` once at module load. Default is
 * the public host. Override is read at process start, so tests that need to
 * point GitHub traffic at a mock must spawn the server with the env var set
 * (the in-process `fastify.inject` tests under `__tests__/` keep working
 * against the default because they stub `fetch` directly).
 *
 * Out of scope here: `https://github.com/login/oauth/*` (the OAuth start /
 * token endpoints live on the web host, not the API host). Those are not
 * exercised by the local E2E framework today.
 */

const DEFAULT_GITHUB_API_BASE = "https://api.github.com";

function normalize(raw: string | undefined): string {
  if (!raw) return DEFAULT_GITHUB_API_BASE;
  return raw.replace(/\/+$/, "");
}

export const GITHUB_API_BASE = normalize(process.env.FIRST_TREE_HUB_GITHUB_API_BASE_URL);
