import { z } from "zod";

/**
 * `GET /api/v1/auth/github/start` query — `next` is the post-login landing
 * path. It is validated again before signing the state JWT (see
 * `safe-redirect.ts`); the schema only enforces the syntactic upper bound
 * so over-long paths bounce with a Zod error rather than silently truncate.
 */
export const githubStartQuerySchema = z.object({
  next: z.string().max(256).optional(),
});
export type GithubStartQuery = z.infer<typeof githubStartQuerySchema>;

export const githubCallbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});
export type GithubCallbackQuery = z.infer<typeof githubCallbackQuerySchema>;

/**
 * Dev-only callback to bypass the GitHub round-trip — sign in as a stub
 * Github user. Gated by NODE_ENV !== 'production'; production always 404s.
 */
export const githubDevCallbackQuerySchema = z.object({
  /** Synthetic GitHub numeric id (acts as `auth_identities.identifier`). */
  githubId: z.string().min(1),
  /** GitHub login slug — used for the default org slug derivation. */
  login: z.string().min(1),
  email: z.string().email().optional(),
  displayName: z.string().optional(),
  next: z.string().max(256).optional(),
});
export type GithubDevCallbackQuery = z.infer<typeof githubDevCallbackQuerySchema>;
