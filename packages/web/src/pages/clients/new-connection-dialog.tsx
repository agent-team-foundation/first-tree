import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { type ConnectTokenResponse, generateConnectToken, type HubClient, listClients } from "../../api/activity.js";
import { useAuth } from "../../auth/auth-context.js";
import { ConnectCommandPanel, type ConnectPhase } from "../../components/connect-command-panel.js";
import { ConnectStuckPanel, STUCK_AFTER_MS } from "../../components/connect-stuck-panel.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { runVisibilityAwareInterval } from "../../lib/visibility-interval.js";

/**
 * Pure detector for the "+ New Connection" wait loop. Exported so the unit
 * test can pin the contract — drift here changes when the modal flips from
 * Waiting to Connected, and the bug fixed in this file (id-set baseline
 * missing reconnects of machines whose client.id is stable per-machine) is
 * the kind of thing that wants a regression net.
 *
 * Detection rule: the client must be owned by the caller, currently connected,
 * and its handshake (`connectedAt`) must have landed at or after the modal
 * was opened. `clients.connectedAt` is rewritten on every fresh handshake —
 * both first-time insert and `ON CONFLICT DO UPDATE` reconnect — so this
 * works for brand-new machines AND re-pairs of previously-known machines.
 *
 * When `targetClientId` is set (re-auth path from an AuthExpired card), the
 * detector only matches that specific row — prevents a card-A reauth from
 * accidentally consuming a card-B connect event when both happen to land in
 * the same poll cycle.
 *
 * @param openedAt epoch-ms; the modal-open timestamp (already adjusted for
 *   any clock-skew fudge by the caller).
 * @param targetClientId optional — when set, only the matching row counts.
 */
export function selectArrivedClient(
  clients: HubClient[],
  openedAt: number,
  userId: string,
  targetClientId?: string,
): HubClient | null {
  if (!userId) return null;
  return (
    clients.find((c) => {
      if (c.status !== "connected" || c.userId !== userId || !c.connectedAt) return false;
      if (targetClientId && c.id !== targetClientId) return false;
      return new Date(c.connectedAt).getTime() >= openedAt;
    }) ?? null
  );
}

const POLL_MS = 5_000;
const SUCCESS_HOLD_MS = 1_200;
// Tolerance subtracted from the modal-open timestamp so a tiny clock skew
// between the browser and the server (or a connect handshake that races a
// hair ahead of the open) still falls inside the "after open" window.
const CONNECT_DETECT_FUDGE_MS = 1_000;
// Buffer subtracted from the server-reported expiry so the modal flips to
// `error` slightly before the token is actually rejected by the connect-token
// exchange endpoint — keeps the "expired" UX strictly aligned with the
// server, never narrower.
const TOKEN_EXPIRY_BUFFER_MS = 2_000;

/**
 * "Connect computer" modal — replaces the always-on ConnectStrip.
 *
 * Lifecycle:
 *   1. open=true        → record open timestamp → mint a connect token
 *   2. phase="waiting"  → poll /clients every 5s; first client owned by the
 *                         caller with status="connected" and connectedAt
 *                         AFTER the open timestamp wins. Timestamp-based so
 *                         re-pairing a machine that already has a client_id
 *                         row (status flips disconnected→connected, id is
 *                         reused) is still detected.
 *                         A `STUCK_AFTER_MS` timer surfaces the recovery
 *                         panel for users who hit the install/firewall wall.
 *                         A token-expiry timer flips to phase=error once the
 *                         server-issued token can no longer be exchanged.
 *   3. phase="success"  → brief hold (~1.2s), then close + invalidate
 *   4. phase="error"    → either mint failed or the token expired before the
 *                         CLI landed. A "Generate new token" button re-runs
 *                         the mint inline without closing the modal.
 *
 * Cancel / backdrop close: drops the unused token (server expires it on TTL).
 */
/**
 * `NewConnectionDialog` props.
 *
 * Default UX is "pair a brand-new computer with this Hub". The optional
 * overrides re-purpose the dialog for the re-auth flow triggered from an
 * AuthExpired computer card — same mint + polling machinery, different
 * wording + a `targetClientId` constraint on the success-arrival detector
 * so card-A's reauth doesn't accidentally consume card-B's arrival event.
 */
export type NewConnectionDialogProps = {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /**
   * Re-auth path only: only the specified clientId counts as arrival.
   * Without this, any newly-connected client owned by the user would
   * succeed — wrong when the user has 2+ AuthExpired cards open and the
   * other one happens to reconnect first.
   */
  targetClientId?: string;
  /** Override dialog title for non-default flows (e.g. re-auth). */
  titleOverride?: string;
  /** Override dialog description. */
  descriptionOverride?: string;
};

export function NewConnectionDialog({
  open,
  onOpenChange,
  targetClientId,
  titleOverride,
  descriptionOverride,
}: NewConnectionDialogProps) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [phase, setPhase] = useState<ConnectPhase>("loading");
  const [token, setToken] = useState<ConnectTokenResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [arrivedHostname, setArrivedHostname] = useState<string | null>(null);
  const [stuck, setStuck] = useState(false);
  const openedAtRef = useRef<number>(0);
  // Tracks whether a mint cycle owned by *this* call is still relevant.
  // Bumped on every new mint (open and regenerate). Stale async settlements
  // compare their snapshot to the live ref before touching state.
  const mintCycleRef = useRef(0);

  /** Generate a fresh connect token and arm the waiting loop. */
  const mintToken = useCallback(async () => {
    const cycle = ++mintCycleRef.current;
    setStuck(false);
    setArrivedHostname(null);
    setPhase("loading");
    setToken(null);
    setErrorMessage(null);
    try {
      const t = await generateConnectToken();
      if (mintCycleRef.current !== cycle) return;
      // Stamp the arrival baseline AFTER the token is in hand. A slow mint
      // shouldn't leave `openedAtRef` pointing several seconds into the past
      // — the arrival detector compares `client.connectedAt >= openedAt`,
      // and a too-old baseline lets stale CLI handshakes from unrelated
      // sessions count as "arrived".
      openedAtRef.current = Date.now() - CONNECT_DETECT_FUDGE_MS;
      setToken(t);
      setPhase("waiting");
    } catch (err) {
      if (mintCycleRef.current !== cycle) return;
      setErrorMessage(err instanceof Error ? err.message : "Failed to generate connect token");
      setPhase("error");
    }
  }, []);

  // 1. On open: mint a token. On close: reset all transient state. The
  //    mint cycle bump in mintToken ensures any in-flight resolve from a
  //    previous open() can't bleed into the new lifecycle.
  //
  //    `targetClientId` is in the dep array even though the effect body
  //    doesn't read it directly: when the user clicks "Generate new
  //    token" on a *different* AuthExpired card while the dialog is
  //    already open, the prop changes (parent rewires the dialog target)
  //    and we want a fresh mint. Without this dep the arrival detector
  //    would silently wait on the old client.id while the visible dialog
  //    header (and the user's mental model) point at a new one.
  //    See PR-B review #1.
  // biome-ignore lint/correctness/useExhaustiveDependencies: targetClientId is intentionally in deps; see block comment above.
  useEffect(() => {
    if (!open) {
      mintCycleRef.current += 1;
      setPhase("loading");
      setToken(null);
      setErrorMessage(null);
      setArrivedHostname(null);
      setStuck(false);
      openedAtRef.current = 0;
      return;
    }
    void mintToken();
  }, [open, mintToken, targetClientId]);

  // 2. While waiting: poll for a client whose handshake landed AFTER the modal
  //    opened. Timestamp comparison (not id-set diff) is what lets us catch a
  //    reconnect of a machine whose client_id row already existed. Polling is
  //    paused while the tab is hidden via `runVisibilityAwareInterval` — a new
  //    computer can't connect via this dialog without a foreground CLI run
  //    elsewhere, and the helper fires an immediate catch-up tick on return.
  useEffect(() => {
    if (!open || phase !== "waiting" || !user) return;
    const tick = async () => {
      try {
        const fresh = await queryClient.fetchQuery({ queryKey: ["clients"], queryFn: listClients });
        const arrived = selectArrivedClient(fresh, openedAtRef.current, user.id, targetClientId);
        if (arrived) {
          setArrivedHostname(arrived.hostname ?? null);
          setPhase("success");
        }
      } catch {
        // transient; next tick will retry
      }
    };
    return runVisibilityAwareInterval(tick, POLL_MS);
  }, [open, phase, queryClient, user, targetClientId]);

  // 2b. Token expiry: server returns `expiresIn` (seconds). When that
  //     elapses, flip to error so the user sees the dead-token state
  //     instead of an indefinite spinner. `open` is in deps to defend
  //     against close→reopen-with-cached-token race (cleanup runs on
  //     close, clearing the previous timer before the next open arms a
  //     new one). The TOKEN_EXPIRY_BUFFER_MS subtraction keeps the UX
  //     strictly aligned with the server contract (never showing the
  //     token as valid past the point the server rejects it).
  useEffect(() => {
    if (!open || !token || phase !== "waiting") return;
    const ms = token.expiresIn * 1_000 - TOKEN_EXPIRY_BUFFER_MS;
    if (ms <= 0) {
      // Server returned a token with no remaining validity (malformed
      // response, or we mis-parsed expiresIn). Flip to error
      // synchronously instead of arming a 0-delay timeout that would
      // race React's render queue.
      setErrorMessage("This token has no remaining validity. Generate a new one to continue.");
      setPhase("error");
      return;
    }
    const handle = window.setTimeout(() => {
      setErrorMessage("This token expired before the computer connected. Generate a new one to continue.");
      setPhase("error");
    }, ms);
    return () => window.clearTimeout(handle);
  }, [open, token, phase]);

  // 2c. Stuck recovery: if the waiting phase drags past STUCK_AFTER_MS,
  //     surface the same recovery panel onboarding shows. Resets the
  //     moment we leave waiting (success or error) so a Regenerate that
  //     also stalls re-arms the panel cleanly.
  useEffect(() => {
    if (!open || phase !== "waiting") {
      setStuck(false);
      return;
    }
    const handle = window.setTimeout(() => setStuck(true), STUCK_AFTER_MS);
    return () => window.clearTimeout(handle);
  }, [open, phase]);

  // 3. On success: brief hold so the user sees the green confirmation, then close.
  useEffect(() => {
    if (phase !== "success") return;
    const handle = setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: ["clients"] });
      onOpenChange(false);
    }, SUCCESS_HOLD_MS);
    return () => clearTimeout(handle);
  }, [phase, onOpenChange, queryClient]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{titleOverride ?? "Connect computer"}</DialogTitle>
          <DialogDescription>
            {descriptionOverride ??
              "Run this command on the machine you want to pair with this Hub. If first-tree isn't installed yet, the command includes the install step."}
          </DialogDescription>
        </DialogHeader>

        <ConnectCommandPanel
          command={token?.bootstrapCommand ?? null}
          expiresInSeconds={token?.expiresIn}
          phase={phase}
          successContent={
            <>
              <span className="font-semibold">{arrivedHostname ?? "Computer"}</span> connected. Closing…
            </>
          }
          errorContent={errorMessage}
          copyButtonPlacement="bottom"
        />

        {stuck && phase === "waiting" && <ConnectStuckPanel />}

        <div className="flex justify-end" style={{ gap: "var(--sp-2)" }}>
          {phase === "error" && (
            <Button variant="outline" size="sm" onClick={() => void mintToken()}>
              Generate new token
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
