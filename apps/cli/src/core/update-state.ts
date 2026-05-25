import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type UpdateAttempt, updateAttemptSchema } from "@first-tree/shared";
import { defaultHome } from "@first-tree/shared/config";

/**
 * Outcome of the last self-update attempt this client ran. Persisted to disk
 * so two independent paths can read it:
 *
 *   1. `update-glue.createExecuteUpdate` — uses the `blocked` state as a
 *      cross-restart loop guard: if the previous attempt installed the same
 *      target version but the running CLI never advanced past the prior
 *      `currentBefore`, we refuse to retry. This is the safety net that
 *      stops a managed service from triggering systemd's StartLimit
 *      ("Start request repeated too quickly" → service stops, client
 *      goes offline) when an install path is silently broken — for
 *      example, an old `npm latest` dist-tag that resolves to the same
 *      version the client is already running.
 *
 *   2. The WebSocket `client:register` frame — the client SDK reads the
 *      most recent record and ships it to the server, which persists it
 *      into `clients.metadata.lastUpdateAttempt` so the admin dashboard
 *      can surface "X clients failed to self-update — last reason: …".
 *      Without this, an EACCES or network-blip failure only shows up in
 *      the local `client.log`, which operators don't see until they SSH
 *      into the machine.
 *
 * The on-the-wire shape is owned by `updateAttemptSchema` in shared. The
 * file lives at `${defaultHome()}/state/update-state.json`. The
 * `state/` subdirectory is created on first write — it's separate from
 * `config/` (user-edited) and `logs/` (high-volume) so future
 * machine-managed state has a home that's intentional, not "wherever a
 * helper happened to drop a file".
 */
export type UpdateState = {
  /** Always-overwritten — newest attempt only. */
  last: UpdateAttempt;
};

/**
 * Override-able location of the state file. Production code uses the
 * default; tests pass a temp path so they don't stomp on the real
 * `~/.first-tree/hub/state/update-state.json`.
 */
export function defaultUpdateStatePath(): string {
  return join(defaultHome(), "state", "update-state.json");
}

/** Read the most recent attempt, or `null` if no attempt has ever been recorded. */
export function readUpdateState(path: string = defaultUpdateStatePath()): UpdateState | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const last = updateAttemptSchema.safeParse((parsed as { last?: unknown }).last);
    if (!last.success) return null;
    return { last: last.data };
  } catch {
    // Corrupt or unreadable — treat as "no state". Better than crashing
    // the CLI on a malformed JSON we can't recover from anyway; the next
    // attempt overwrites it.
    return null;
  }
}

/**
 * Persist the given attempt as the most recent record. Atomic in the
 * single-writer sense — only `update-glue.createExecuteUpdate` writes to
 * this file, and a CLI process never runs two `executeUpdate` calls
 * concurrently (UpdateManager's `updateInFlight` lock guarantees it).
 */
export function recordUpdateAttempt(attempt: UpdateAttempt, path: string = defaultUpdateStatePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const payload: UpdateState = { last: attempt };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

/**
 * `true` when the last recorded attempt was `blocked` for *this exact
 * target version*. Server moving on to a different version clears the
 * block automatically — only the specific (target, machine) pair stays
 * frozen. Loop guard does not block on `failed`: those should retry
 * (transient EACCES / network), and the UpdateManager already handles
 * the back-off via "next welcome frame".
 */
export function isLoopGuarded(target: string, path: string = defaultUpdateStatePath()): boolean {
  const state = readUpdateState(path);
  if (!state) return false;
  return state.last.result === "blocked" && state.last.target === target;
}

export type { UpdateAttempt } from "@first-tree/shared";
