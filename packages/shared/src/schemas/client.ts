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
 * The WS inbox data plane is mandatory on this server build; this capability
 * block now carries only explicitly negotiated session behavior.
 */
export const clientWireCapabilitiesSchema = z
  .object({
    /**
     * Version 1 of the COMPOSITE Reset protocol (see `wsSessionResetV1` in
     * the server capabilities): apply-ack plus parked-fence release on the
     * exact terminate ref plus BOTH receipted terminal dispositions —
     * `session:command:finalized:ack` for a durable eviction and
     * `session:command:aborted:ack` for a Reset the server could not finalize.
     * Both dispositions belong to this one version: a peer that could answer
     * only the finalized half would stay fenced on every abort branch, so
     * there is nothing to negotiate separately. Declared ONLY when the server
     * advertised `wsSessionResetV1` in its welcome, so the flag proves both
     * peers speak the same version. The server gates
     * `terminate?waitForApply=true` on this field alone.
     */
    wsSessionResetV1: z.boolean().default(false),
    /**
     * Version 1 of the controlled runtime-install command/result protocol.
     * Declared only after the server advertises the same capability, so a
     * request cannot be sent to an older daemon that would silently ignore it.
     */
    runtimeInstallV1: z.boolean().default(false),
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
