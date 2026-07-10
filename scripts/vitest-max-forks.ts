/**
 * Shared Vitest fork cap for monorepo packages.
 *
 * Why this exists:
 * - GitHub-hosted `ubuntu-latest` runners have ~7GB RAM.
 * - Node's default heap ceiling is ~4GB per process.
 * - `turbo run test` fans out several packages at once; each package's
 *   vitest workers then stack on top of that. CLI workers have already
 *   OOM'd at Mark-Compact ~4057MB under the previous defaults.
 *
 * Defaults:
 * - Local: 2 forks (enough file parallelism without starving a laptop).
 * - CI / GITHUB_ACTIONS: 1 fork unless `VITEST_MAX_FORKS` overrides.
 *
 * Override via `VITEST_MAX_FORKS` for beefier CI runners or local bisects.
 */
export function resolveVitestMaxForks(defaultLocal = 2): number {
  const envCap = Number.parseInt(process.env.VITEST_MAX_FORKS ?? "", 10);
  if (Number.isFinite(envCap) && envCap > 0) {
    return envCap;
  }

  const isCi = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
  return isCi ? 1 : defaultLocal;
}

export function isCiEnvironment(): boolean {
  return process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
}
