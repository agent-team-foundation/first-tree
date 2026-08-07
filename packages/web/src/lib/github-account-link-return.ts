const STORAGE_KEY = "settings:github:account-link-return";
const RETURN_TTL_MS = 30 * 60 * 1000;

type AccountLinkReturn = {
  organizationId: string;
  startedAt: number;
};

/**
 * Preserve UX context across the full-page GitHub account-link round trip.
 * This marker is deliberately not authority: it contains no token and every
 * later Team operation is still authorized by the server against live data.
 */
export function rememberGithubAccountLinkReturn(organizationId: string): void {
  window.sessionStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ organizationId, startedAt: Date.now() } satisfies AccountLinkReturn),
  );
}

export function readGithubAccountLinkReturn(): AccountLinkReturn | null {
  const raw = window.sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" ||
      value === null ||
      !("organizationId" in value) ||
      typeof value.organizationId !== "string" ||
      value.organizationId.length === 0 ||
      value.organizationId.length > 200 ||
      !("startedAt" in value) ||
      typeof value.startedAt !== "number" ||
      Date.now() - value.startedAt > RETURN_TTL_MS
    ) {
      clearGithubAccountLinkReturn();
      return null;
    }
    return { organizationId: value.organizationId, startedAt: value.startedAt };
  } catch {
    clearGithubAccountLinkReturn();
    return null;
  }
}

export function clearGithubAccountLinkReturn(): void {
  window.sessionStorage.removeItem(STORAGE_KEY);
}

export function githubSettingsErrorReturnPath(code: string, flow: "install" | "link"): string {
  return `/settings/github?error=${encodeURIComponent(code)}&flow=${flow}`;
}
