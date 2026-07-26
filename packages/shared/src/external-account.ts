import type { AuthProvider } from "./schemas/oauth.js";

export const USERNAME_MAX_LENGTH = 100;
export const USERNAME_SUFFIX_RESERVE = 13;
export const USERNAME_BASE_MAX_LENGTH = USERNAME_MAX_LENGTH - USERNAME_SUFFIX_RESERVE;
export const DISPLAY_NAME_MAX_LENGTH = 200;

export type ExternalAccountProfile = {
  provider: AuthProvider;
  subject: string;
  usernameCandidates: string[];
  displayName: string | null;
  email: string | null;
  avatarUrl: string | null;
  metadata: Record<string, unknown>;
};

export function normalizeUsername(value: string, fallback: string): string {
  const normalized = normalizeUsernameValue(value);
  if (normalized) return normalized;
  const safeFallback = normalizeUsernameValue(fallback);
  return safeFallback || "user";
}

function normalizeUsernameValue(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, USERNAME_BASE_MAX_LENGTH)
    .replace(/-+$/g, "");
}

export function normalizeExternalProfile(profile: ExternalAccountProfile): {
  username: string;
  displayName: string;
} {
  const fallback = `${profile.provider}-user`;
  const username =
    profile.usernameCandidates
      .filter((candidate) => candidate.trim().length > 0)
      .map(normalizeUsernameValue)
      .find(Boolean) ?? fallback;
  const displayName = (profile.displayName ?? "").trim().replace(/\s+/g, " ").slice(0, DISPLAY_NAME_MAX_LENGTH);
  return { username, displayName: displayName || username || "User" };
}

export function githubExternalProfile(input: {
  id: string | number;
  login: string;
  name?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  metadata?: Record<string, unknown>;
}): ExternalAccountProfile {
  return {
    provider: "github",
    subject: String(input.id),
    usernameCandidates: [input.login, input.name ?? "", "github-user"],
    displayName: input.name ?? input.login,
    email: input.email ?? null,
    avatarUrl: input.avatarUrl ?? null,
    metadata: { login: input.login, ...(input.metadata ?? {}) },
  };
}

export function googleExternalProfile(input: {
  sub: string;
  name?: string | null;
  email?: string | null;
  emailVerified?: boolean;
  picture?: string | null;
}): ExternalAccountProfile {
  const localPart = input.emailVerified && input.email ? (input.email.split("@")[0] ?? "") : "";
  return {
    provider: "google",
    subject: input.sub,
    usernameCandidates: [localPart, input.name ?? "", "google-user"],
    displayName: input.name ?? null,
    email: input.email ?? null,
    avatarUrl: input.picture ?? null,
    metadata: {},
  };
}
