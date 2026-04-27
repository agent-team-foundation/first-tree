import { z } from "zod";

/** Supported third-party identity providers. */
export const AUTH_PROVIDERS = {
  GITHUB: "github",
} as const;

export const authProviderNameSchema = z.enum(["github"]);
export type AuthProviderName = z.infer<typeof authProviderNameSchema>;

/**
 * One row per (provider, provider_user_id) — links a third-party identity to
 * a `users.id`. See docs/saas-onboarding-journey.md §5.2.
 */
export const authProviderSchema = z.object({
  id: z.string(),
  userId: z.string(),
  provider: authProviderNameSchema,
  /** Provider's stable opaque user id (e.g. GitHub numeric id as string). */
  providerUserId: z.string(),
  /** Email returned by the provider at link time (audit only). */
  emailAtLink: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AuthProvider = z.infer<typeof authProviderSchema>;
