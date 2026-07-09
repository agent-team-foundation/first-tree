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
  /**
   * Opaque connect token accepted by `<binName> login <code>`. New servers
   * return a bare short code; legacy JWT connect tokens remain accepted by the
   * exchange endpoint during rollout.
   */
  token: z.string(),
  expiresIn: z.number(),
  /** `<binName> login <code>` — channel-aware bin name. */
  command: z.string(),
  /**
   * Full bootstrap line shown by web onboarding / connect-computer dialogs.
   * For prod/staging: `npm install -g <pkg>\n<binName> login <code>`.
   * For dev (server has no published package): just the `<binName> login
   * <code>` line.
   */
  bootstrapCommand: z.string(),
  /**
   * Bare npm package name (no `@<dist-tag>` suffix; multi-env each
   * channel has its own `latest`). `null` for dev servers — the web UI
   * suppresses the `npm install -g` step.
   */
  npmSpec: z.string().nullable(),
  /**
   * Bootstrap install method selected by the server. `npm` remains the
   * default for published channels until operators opt in to portable
   * bootstrap. `source` is dev-only.
   */
  installMethod: z.enum(["npm", "portable", "source"]),
  /**
   * Public installer URL when `installMethod=portable`. Connect tokens never
   * appear here; the token is only in the local login command.
   */
  installerUrl: z.string().url().nullable(),
  /**
   * Bin name the operator types after install. Channel-aware:
   *   - prod    → "first-tree"
   *   - staging → "first-tree-staging"
   *   - dev     → "first-tree-dev"
   * Web onboarding uses this to render the right `… login <code>` line
   * (and the right `… agent add` prefix in the new-agent-dialog).
   */
  binName: z.string(),
});
export type ConnectTokenResponse = z.infer<typeof connectTokenResponseSchema>;
