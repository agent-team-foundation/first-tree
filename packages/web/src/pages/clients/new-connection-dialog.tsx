import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { type ConnectTokenResponse, generateConnectToken, type HubClient, listClients } from "../../api/activity.js";
import { useAuth } from "../../auth/auth-context.js";
import { ConnectCommandPanel, type ConnectPhase } from "../../components/connect-command-panel.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";

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
 * @param openedAt epoch-ms; the modal-open timestamp (already adjusted for
 *   any clock-skew fudge by the caller).
 */
export function selectArrivedClient(clients: HubClient[], openedAt: number, userId: string): HubClient | null {
  if (!userId) return null;
  return (
    clients.find((c) => {
      if (c.status !== "connected" || c.userId !== userId || !c.connectedAt) return false;
      return new Date(c.connectedAt).getTime() >= openedAt;
    }) ?? null
  );
}

const POLL_MS = 3_000;
const SUCCESS_HOLD_MS = 1_200;
// Tolerance subtracted from the modal-open timestamp so a tiny clock skew
// between the browser and the server (or a connect handshake that races a
// hair ahead of the open) still falls inside the "after open" window.
const CONNECT_DETECT_FUDGE_MS = 1_000;

/**
 * "Connect computer" modal — replaces the always-on ConnectStrip.
 *
 * Lifecycle:
 *   1. open=true        → record open timestamp → mint a connect token
 *   2. phase="waiting"  → poll /clients every 3s; first client owned by the
 *                         caller with status="connected" and connectedAt
 *                         AFTER the open timestamp wins. Timestamp-based so
 *                         re-pairing a machine that already has a client_id
 *                         row (status flips disconnected→connected, id is
 *                         reused) is still detected.
 *   3. phase="success"  → brief hold (~1.2s), then close + invalidate
 *
 * Cancel / backdrop close: drops the unused token (server expires it on TTL).
 */
export function NewConnectionDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (next: boolean) => void }) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [phase, setPhase] = useState<ConnectPhase>("loading");
  const [token, setToken] = useState<ConnectTokenResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [arrivedHostname, setArrivedHostname] = useState<string | null>(null);
  const openedAtRef = useRef<number>(0);

  // 1. On open: stamp open time, mint, switch to waiting. Reset all state on close.
  useEffect(() => {
    if (!open) {
      setPhase("loading");
      setToken(null);
      setErrorMessage(null);
      setArrivedHostname(null);
      openedAtRef.current = 0;
      return;
    }

    let cancelled = false;
    openedAtRef.current = Date.now() - CONNECT_DETECT_FUDGE_MS;

    (async () => {
      try {
        const t = await generateConnectToken();
        if (cancelled) return;
        setToken(t);
        setPhase("waiting");
      } catch (err) {
        if (cancelled) return;
        setErrorMessage(err instanceof Error ? err.message : "Failed to generate connect token");
        setPhase("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  // 2. While waiting: poll for a client whose handshake landed AFTER the modal
  //    opened. Timestamp comparison (not id-set diff) is what lets us catch a
  //    reconnect of a machine whose client_id row already existed.
  useEffect(() => {
    if (!open || phase !== "waiting" || !user) return;
    const tick = async () => {
      try {
        const fresh = await queryClient.fetchQuery({ queryKey: ["clients"], queryFn: listClients });
        const arrived = selectArrivedClient(fresh, openedAtRef.current, user.id);
        if (arrived) {
          setArrivedHostname(arrived.hostname ?? null);
          setPhase("success");
        }
      } catch {
        // transient; next tick will retry
      }
    };
    const handle = setInterval(tick, POLL_MS);
    return () => clearInterval(handle);
  }, [open, phase, queryClient, user]);

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
          <DialogTitle>Connect computer</DialogTitle>
          <DialogDescription>Run this command on the machine you want to pair with this Hub.</DialogDescription>
        </DialogHeader>

        <ConnectCommandPanel
          command={token?.command ?? null}
          expiresInSeconds={token?.expiresIn}
          phase={phase}
          successContent={
            <>
              <span className="font-semibold">{arrivedHostname ?? "Computer"}</span> connected. Closing…
            </>
          }
          errorContent={errorMessage}
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
