import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type ConnectTokenResponse, generateConnectToken, type HubClient, listClients } from "../../api/activity.js";
import { useAuth } from "../../auth/auth-context.js";
import { ConnectCommandPanel, type ConnectPhase, ConnectStatusRow } from "../../components/connect-command-panel.js";
import { STUCK_AFTER_MS } from "../../components/connect-stuck-panel.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { runVisibilityAwareInterval } from "../../lib/visibility-interval.js";
import { selectArrivedClient } from "./new-connection-dialog.js";

const POLL_MS = 5_000;
const SUCCESS_HOLD_MS = 1_200;
// Tolerance subtracted from the modal-open timestamp so a tiny clock skew
// between the browser and the server (or a handshake that races a hair ahead
// of the open) still falls inside the "after open" arrival window. Same
// rationale as the `+ Connect` dialog's fudge.
const RECONNECT_DETECT_FUDGE_MS = 1_000;
// Buffer subtracted from the fallback token's server-reported expiry so the
// panel surfaces "expired, regenerate" slightly before the server rejects it.
const TOKEN_EXPIRY_BUFFER_MS = 2_000;

// Lazy-mint lifecycle for the "Still offline?" reinstall fallback.
type FallbackPhase = "idle" | "loading" | "ready" | "error";

/**
 * "Reconnect {hostname}" modal — the offline-card primary action.
 *
 * An offline computer that already reported the CLI + a runtime is a KNOWN,
 * still-credentialed machine that merely lost its heartbeat (the common cause
 * is the background daemon not running). So the reconnect flow is deliberately
 * *lighter* than the `+ Connect` / re-auth flow:
 *
 *   - Primary command is `<binName> daemon start` — no reinstall, no fresh
 *     login, no connect token. This is the fix for the by-far most common
 *     offline cause and needs zero server round-trip.
 *   - The full `npm install -g … && … login <token>` path (identical to
 *     `+ Connect`) is demoted to a "Still offline?" disclosure and its token
 *     is minted lazily, only when the operator expands it (or after a stuck
 *     timeout auto-expands it) — a machine that is merely asleep should never
 *     cost a connect token.
 *
 * Both paths converge on the same success signal: we poll `/clients` scoped to
 * THIS machine's id and flip to success the moment its handshake lands after
 * the modal opened (`selectArrivedClient` with `targetClientId`). Scoping to
 * the row prevents an unrelated machine's reconnect from closing this modal.
 * The arrival status row lives at DIALOG level (below both commands) so it
 * plainly covers "whichever command you ran", not just `daemon start`.
 *
 * Contrast with `NewConnectionDialog`, which mints a token on open and leads
 * with install+login because it targets an unknown / unpaired machine.
 */
export type ReconnectDialogProps = {
  /** The offline machine being reconnected. `null` keeps the dialog closed. */
  client: HubClient | null;
  onOpenChange: (next: boolean) => void;
};

export function ReconnectDialog({ client, onOpenChange }: ReconnectDialogProps) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const open = client !== null;
  const clientId = client?.id ?? null;
  const hostname = client?.hostname ?? "this computer";
  const binName = client?.binName ?? "first-tree";
  const daemonStartCommand = `${binName} daemon start`;

  const [phase, setPhase] = useState<ConnectPhase>("waiting");
  const [arrivedHostname, setArrivedHostname] = useState<string | null>(null);
  const [stuck, setStuck] = useState(false);
  // Fallback (reinstall + login) disclosure state. The token is minted lazily
  // the first time the disclosure opens (manually or via the stuck timeout).
  const [showFallback, setShowFallback] = useState(false);
  const [fallbackPhase, setFallbackPhase] = useState<FallbackPhase>("idle");
  const [fallbackToken, setFallbackToken] = useState<ConnectTokenResponse | null>(null);
  const [fallbackError, setFallbackError] = useState<string | null>(null);
  const openedAtRef = useRef<number>(0);
  // Bumped on every open / target-change / close so a stale async token mint
  // from a previous lifecycle can't settle into the current one.
  const cycleRef = useRef(0);
  // Guards against a concurrent double-mint (rapid toggle / stuck racing a
  // manual expand) before `fallbackPhase` has flushed to "loading".
  const mintingRef = useRef(false);

  // Mint a fresh connect token for the reinstall fallback. Cycle-guarded so a
  // settle after close/target-change is discarded; ref-guarded against a
  // concurrent second call.
  const mintFallback = useCallback(async () => {
    if (mintingRef.current) return;
    mintingRef.current = true;
    const cycle = cycleRef.current;
    setFallbackPhase("loading");
    setFallbackToken(null);
    setFallbackError(null);
    try {
      const t = await generateConnectToken();
      if (cycleRef.current !== cycle) return;
      setFallbackToken(t);
      setFallbackPhase("ready");
    } catch (err) {
      if (cycleRef.current !== cycle) return;
      setFallbackError(err instanceof Error ? err.message : "Failed to generate connect token");
      setFallbackPhase("error");
    } finally {
      mintingRef.current = false;
    }
  }, []);

  const revealFallback = useCallback(() => {
    setShowFallback(true);
    if (fallbackPhase === "idle") void mintFallback();
  }, [fallbackPhase, mintFallback]);

  // On open (and whenever the target machine changes): stamp the arrival
  // baseline, arm the waiting loop, and reset the fallback disclosure. On
  // close: bump the cycle so in-flight mints are ignored and reset state.
  //
  // `clientId` is in deps even though the body doesn't read it: switching the
  // Reconnect target to a different offline machine while the dialog is open
  // must re-stamp the arrival baseline and reset the fallback, otherwise the
  // detector keeps waiting on the previous row.
  // biome-ignore lint/correctness/useExhaustiveDependencies: clientId is intentionally in deps; see comment above.
  useEffect(() => {
    cycleRef.current += 1;
    mintingRef.current = false;
    setShowFallback(false);
    setFallbackPhase("idle");
    setFallbackToken(null);
    setFallbackError(null);
    setArrivedHostname(null);
    setStuck(false);
    if (!open) {
      setPhase("waiting");
      openedAtRef.current = 0;
      return;
    }
    openedAtRef.current = Date.now() - RECONNECT_DETECT_FUDGE_MS;
    setPhase("waiting");
  }, [open, clientId]);

  // While waiting: poll for THIS machine's handshake landing after the modal
  // opened. Scoped to `clientId` so only this row's reconnect counts. Paused
  // while the tab is hidden (the CLI run happens on another machine anyway).
  useEffect(() => {
    if (!open || phase !== "waiting" || !user || !clientId) return;
    const tick = async () => {
      try {
        const fresh = await queryClient.fetchQuery({ queryKey: ["clients"], queryFn: listClients });
        const arrived = selectArrivedClient(fresh, openedAtRef.current, user.id, clientId);
        if (arrived) {
          setArrivedHostname(arrived.hostname ?? null);
          setPhase("success");
        }
      } catch {
        // transient; next tick retries
      }
    };
    return runVisibilityAwareInterval(tick, POLL_MS);
  }, [open, phase, queryClient, user, clientId]);

  // On success: brief green hold, then close + refresh the list.
  useEffect(() => {
    if (phase !== "success") return;
    const handle = setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: ["clients"] });
      onOpenChange(false);
    }, SUCCESS_HOLD_MS);
    return () => clearTimeout(handle);
  }, [phase, onOpenChange, queryClient]);

  // Stuck escalation: if `daemon start` hasn't brought the machine back after
  // STUCK_AFTER_MS, auto-expand the reinstall fallback so a stuck operator is
  // nudged toward the heavier path instead of waiting on the spinner forever.
  useEffect(() => {
    if (!open || phase !== "waiting") {
      setStuck(false);
      return;
    }
    const handle = window.setTimeout(() => setStuck(true), STUCK_AFTER_MS);
    return () => window.clearTimeout(handle);
  }, [open, phase]);
  useEffect(() => {
    if (stuck) revealFallback();
  }, [stuck, revealFallback]);

  // Fallback token expiry: flip to an actionable error (with a regenerate
  // button) instead of leaving a silently-dead token in the panel.
  useEffect(() => {
    if (!open || fallbackPhase !== "ready" || !fallbackToken) return;
    const ms = fallbackToken.expiresIn * 1_000 - TOKEN_EXPIRY_BUFFER_MS;
    if (ms <= 0) {
      setFallbackError("This token has no remaining validity. Generate a new one to continue.");
      setFallbackPhase("error");
      return;
    }
    const handle = window.setTimeout(() => {
      setFallbackError("This token expired before the computer connected. Generate a new one to continue.");
      setFallbackPhase("error");
    }, ms);
    return () => window.clearTimeout(handle);
  }, [open, fallbackPhase, fallbackToken]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reconnect {hostname}</DialogTitle>
          <DialogDescription>
            This computer is already set up — it just went offline. Run this on {hostname} to bring it back online:
          </DialogDescription>
        </DialogHeader>

        <ConnectCommandPanel command={daemonStartCommand} phase="loading" caption={null} copyButtonPlacement="bottom" />

        <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
          <button
            type="button"
            onClick={() => (showFallback ? setShowFallback(false) : revealFallback())}
            className="flex items-center text-caption"
            style={{
              alignSelf: "flex-start",
              background: "transparent",
              color: "var(--fg-3)",
              border: "none",
              padding: 0,
              gap: "var(--sp-1)",
              cursor: "pointer",
            }}
            aria-expanded={showFallback}
            aria-controls="reconnect-fallback"
          >
            {showFallback ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            Still offline? Reinstall and sign in again
          </button>
          {showFallback && (
            <div id="reconnect-fallback" className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
              {fallbackPhase === "error" ? (
                <>
                  <ConnectStatusRow phase="error" errorContent={fallbackError} />
                  <Button
                    variant="outline"
                    size="sm"
                    style={{ alignSelf: "flex-start" }}
                    onClick={() => void mintFallback()}
                  >
                    Generate new token
                  </Button>
                </>
              ) : (
                <ConnectCommandPanel
                  command={fallbackToken?.bootstrapCommand ?? null}
                  expiresInSeconds={fallbackToken?.expiresIn}
                  phase="loading"
                  copyButtonPlacement="bottom"
                />
              )}
            </div>
          )}
        </div>

        {/* Single machine-arrival status row at dialog level — covers whichever
            command the operator actually ran. */}
        <ConnectStatusRow
          phase={phase}
          waitingText={`Waiting for ${hostname} to come back online…`}
          successContent={
            <>
              <span className="font-semibold">{arrivedHostname ?? hostname}</span> is back online. Closing…
            </>
          }
        />

        <div className="flex justify-end" style={{ gap: "var(--sp-2)" }}>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
