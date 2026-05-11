/**
 * Runtime-wide constants (Step 7 + Step 11).
 *
 * After Step 11 these values are fixed at code level — the previously
 * exposed `session.idle_timeout` / `session.max_sessions` / `concurrency`
 * fields in `agent.yaml` are dropped per PRD §D1 / §D15.
 *
 * Picked deliberately wide for M1 internal use; revisit when scale shows
 * a real bottleneck.
 */

/** 8 hours — covers "leave it on overnight" usage without holding worktrees forever. */
export const IDLE_TIMEOUT_MS = 8 * 60 * 60 * 1000;

/** Per-agent max simultaneously-active sessions. */
export const MAX_SESSIONS = 50;

/** Per-agent in-flight runtime concurrency cap. */
export const CONCURRENCY = 16;

/** How often the session manager scans for idle sessions to reclaim. */
export const IDLE_SCAN_INTERVAL_MS = 60_000;
