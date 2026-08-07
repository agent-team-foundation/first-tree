const STORAGE_KEY = "settings:github:install-attempt";
const ATTEMPT_TTL_MS = 30 * 60 * 1000;

export type GithubInstallAttempt = {
  organizationId: string;
  startedAt: number;
};

export function rememberGithubInstallAttempt(organizationId: string): void {
  window.sessionStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ organizationId, startedAt: Date.now() } satisfies GithubInstallAttempt),
  );
}

export function readGithubInstallAttempt(): GithubInstallAttempt | null {
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
      Date.now() - value.startedAt > ATTEMPT_TTL_MS
    ) {
      clearGithubInstallAttempt();
      return null;
    }
    return { organizationId: value.organizationId, startedAt: value.startedAt };
  } catch {
    clearGithubInstallAttempt();
    return null;
  }
}

export function hasGithubInstallAttempt(): boolean {
  return readGithubInstallAttempt() !== null;
}

export function hasGithubInstallAttemptForOrganization(organizationId: string | null): boolean {
  if (!organizationId) return false;
  return readGithubInstallAttempt()?.organizationId === organizationId;
}

export function clearGithubInstallAttemptForOrganization(organizationId: string | null): void {
  if (organizationId && readGithubInstallAttempt()?.organizationId === organizationId) {
    clearGithubInstallAttempt();
  }
}

export function clearGithubInstallAttempt(): void {
  window.sessionStorage.removeItem(STORAGE_KEY);
}
