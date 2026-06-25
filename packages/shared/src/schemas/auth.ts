import { z } from "zod";

export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type Login = z.infer<typeof loginSchema>;

export const loginResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshToken = z.infer<typeof refreshTokenSchema>;

export const connectTokenExchangeSchema = z.object({
  token: z.string().min(1),
});
export type ConnectTokenExchange = z.infer<typeof connectTokenExchangeSchema>;

export const connectTokenResponseSchema = z.object({
  token: z.string(),
  expiresIn: z.number(),
  /** `<binName> login <token>` — channel-aware bin name. */
  command: z.string(),
  /**
   * Full bootstrap line shown by web onboarding / connect-computer dialogs.
   * For prod/staging: `npm install -g <pkg>@<version>\n<binName> login <token>`.
   * For dev (server has no published package): just the `<binName> login
   * <token>` line.
   */
  bootstrapCommand: z.string(),
  /**
   * npm install spec for the CLI package. Published channels include the
   * exact server-advertised version; `null` for dev servers where the web
   * UI suppresses the `npm install -g` step.
   */
  npmSpec: z.string().nullable(),
  /**
   * Bin name the operator types after install. Channel-aware:
   *   - prod    → "first-tree"
   *   - staging → "first-tree-staging"
   *   - dev     → "first-tree-dev"
   * Web onboarding uses this to render the right `… login <token>` line
   * (and the right `… agent add` prefix in the new-agent-dialog).
   */
  binName: z.string(),
});
export type ConnectTokenResponse = z.infer<typeof connectTokenResponseSchema>;
