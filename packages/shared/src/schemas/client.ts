import { z } from "zod";

// -- Client Status --

export const CLIENT_STATUSES = {
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
} as const;

export const clientStatusSchema = z.enum(["connected", "disconnected"]);
export type ClientStatus = z.infer<typeof clientStatusSchema>;

/**
 * Auth health channel surfaced to the Web admin dashboard. Computed
 * server-side per request from the row's offline duration vs the
 * configured refresh-token TTL — there is no DB column. See
 * `deriveAuthState` server-side.
 *
 *   - `ok`      — online, or recently offline (cached refresh token can
 *                 plausibly still mint access tokens).
 *   - `expired` — offline longer than the refresh-token TTL; the client
 *                 cannot recover on its own. The operator mints a fresh
 *                 connect token via the Web "+ New Connection" button
 *                 (or the inline Reconnect button on the row).
 */
export const clientAuthStateSchema = z.enum(["ok", "expired"]);
export type ClientAuthState = z.infer<typeof clientAuthStateSchema>;

// -- Client --

export const clientSchema = z.object({
  id: z.string(),
  /** Owning user id (nullable until a legacy client re-registers under an authenticated JWT). */
  userId: z.string().nullable(),
  status: clientStatusSchema,
  /** See {@link clientAuthStateSchema}. Computed server-side; not persisted. */
  authState: clientAuthStateSchema,
  /** Channel-aware CLI binary name for command-line UX. */
  binName: z.string(),
  sdkVersion: z.string().max(50).nullable(),
  hostname: z.string().max(100).nullable(),
  os: z.string().max(50).nullable(),
  agentCount: z.number().int().min(0),
  connectedAt: z.string().nullable(),
  lastSeenAt: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
});
export type Client = z.infer<typeof clientSchema>;

// -- Client Register (WS payload from client SDK) --

/**
 * Optional opt-in flags the client carries on `client:register` to advertise
 * which negotiable wire-protocol features it implements. Distinct from
 * `clientCapabilitiesSchema` (per-runtime-provider availability — different
 * concept).
 *
 * 0.10.4 ~ 0.14.2 clients still send this block (with `wsInboxDeliver: true`
 * hard-coded). The 0.14.3+ runtime omits it. The schema is retained so that
 * middle-version `client:register` frames still parse, even though the
 * server no longer reads any of these fields — the WS inbox data plane is
 * mandatory on this server build.
 */
export const clientWireCapabilitiesSchema = z
  .object({
    /**
     * Historical opt-in for the `inbox:deliver` push path. The server now
     * ignores the value; 0.10.4 ~ 0.14.2 clients still emit it as `true`.
     * Kept for parse-compat only; safe to remove after 0.16 once those
     * middle-version installs are no longer in the field.
     */
    wsInboxDeliver: z.boolean().default(false),
  })
  .partial();
export type ClientWireCapabilities = z.infer<typeof clientWireCapabilitiesSchema>;

/**
 * Outcome of the client's last self-update attempt. Carried on
 * `client:register` so the server can persist it into
 * `clients.metadata.lastUpdateAttempt`, surfacing in the admin
 * dashboard whichever clients are failing to auto-update — without
 * needing per-machine SSH to grep `client.log`.
 *
 * Length caps protect the WS frame budget: even a verbose npm stderr
 * gets truncated client-side before persisting, but `.max()` here is the
 * server-side guard against a hostile or buggy client sending a
 * megabyte-long reason.
 */
export const updateAttemptSchema = z.object({
  result: z.enum(["ok", "failed", "blocked"]),
  target: z.string().min(1).max(64),
  currentBefore: z.string().min(1).max(64),
  installedVersion: z.string().min(1).max(64).nullable(),
  reason: z.string().max(500).nullable(),
  /** ISO timestamp the attempt finished. */
  at: z.string().min(1).max(40),
});
export type UpdateAttempt = z.infer<typeof updateAttemptSchema>;

export const clientRegisterSchema = z.object({
  clientId: z.string().min(1).max(100),
  hostname: z.string().max(100).optional(),
  os: z.string().max(50).optional(),
  sdkVersion: z.string().max(50).optional(),
  wireCapabilities: clientWireCapabilitiesSchema.optional(),
  /**
   * Most recent self-update outcome, if any. Optional — a freshly
   * installed client (no prior attempts) and older clients (no report
   * path wired) both omit it. Server persists into
   * `clients.metadata.lastUpdateAttempt` on receipt.
   */
  lastUpdateAttempt: updateAttemptSchema.optional(),
});
export type ClientRegister = z.infer<typeof clientRegisterSchema>;

// -- Client Claim (POST /me/clients/:clientId/claim) --

/**
 * Response body for ownership transfer. The previous owner's user_id (null
 * for legacy unclaimed rows) and the count of agents whose pin was cleared
 * by the transaction (decouple-client-from-identity §4.4).
 */
export const claimClientResponseSchema = z.object({
  clientId: z.string(),
  previousUserId: z.string().nullable(),
  unpinnedAgentCount: z.number().int().nonnegative(),
});
export type ClaimClientResponse = z.infer<typeof claimClientResponseSchema>;
