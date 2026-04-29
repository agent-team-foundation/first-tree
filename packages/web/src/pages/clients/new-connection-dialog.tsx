import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { type ConnectTokenResponse, generateConnectToken, type HubClient, listClients } from "../../api/activity.js";
import { useAuth } from "../../auth/auth-context.js";
import { ConnectCommandPanel, type ConnectPhase } from "../../components/connect-command-panel.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";

const POLL_MS = 3_000;
const SUCCESS_HOLD_MS = 1_200;

/**
 * "Connect a new computer" modal — replaces the always-on ConnectStrip.
 *
 * Lifecycle:
 *   1. open=true        → snapshot existing client ids → mint a connect token
 *   2. phase="waiting"  → poll /clients every 3s; first new id with
 *                         status="connected" AND owned by the caller wins
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
  const baselineRef = useRef<Set<string>>(new Set());

  // 1. On open: snapshot, mint, switch to waiting. Reset all state on close.
  useEffect(() => {
    if (!open) {
      setPhase("loading");
      setToken(null);
      setErrorMessage(null);
      setArrivedHostname(null);
      baselineRef.current = new Set();
      return;
    }

    let cancelled = false;
    const existing = (queryClient.getQueryData<HubClient[]>(["clients"]) ?? []).map((c) => c.id);
    baselineRef.current = new Set(existing);

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
  }, [open, queryClient]);

  // 2. While waiting: poll for the new client. Owner check guards admin role.
  useEffect(() => {
    if (!open || phase !== "waiting" || !user) return;
    const tick = async () => {
      try {
        const fresh = await queryClient.fetchQuery({ queryKey: ["clients"], queryFn: listClients });
        const baseline = baselineRef.current;
        const arrived = fresh.find((c) => !baseline.has(c.id) && c.status === "connected" && c.userId === user.id);
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
          <DialogTitle>Connect a new computer</DialogTitle>
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
