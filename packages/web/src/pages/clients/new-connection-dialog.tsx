import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type ConnectTokenResponse, generateConnectToken, type HubClient, listClients } from "../../api/activity.js";
import { useAuth } from "../../auth/auth-context.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";

type Phase = "loading" | "waiting" | "success" | "error";

const POLL_MS = 3_000;
const SUCCESS_HOLD_MS = 1_200;
const COPY_FEEDBACK_MS = 1_500;

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
  const [phase, setPhase] = useState<Phase>("loading");
  const [token, setToken] = useState<ConnectTokenResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [arrivedHostname, setArrivedHostname] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const baselineRef = useRef<Set<string>>(new Set());

  // 1. On open: snapshot, mint, switch to waiting. Reset all state on close.
  useEffect(() => {
    if (!open) {
      setPhase("loading");
      setToken(null);
      setErrorMessage(null);
      setArrivedHostname(null);
      setCopied(false);
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

  const handleCopy = async () => {
    if (!token) return;
    await navigator.clipboard.writeText(token.command);
    setCopied(true);
    setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect a new computer</DialogTitle>
          <DialogDescription>Run this command on the machine you want to pair with this Hub.</DialogDescription>
        </DialogHeader>

        <div className="flex" style={{ gap: "var(--sp-2)", alignItems: "stretch" }}>
          <code
            className="mono text-label flex-1"
            style={{
              padding: "var(--sp-2_5) var(--sp-3)",
              background: "var(--bg-sunken)",
              border: "var(--hairline) solid var(--border-faint)",
              borderRadius: "var(--radius-input)",
              color: "var(--fg-2)",
              wordBreak: "break-all",
            }}
            title={token?.command ?? ""}
          >
            {token ? (
              <>
                {token.command}{" "}
                <span style={{ color: "var(--fg-4)" }}># expires in {Math.round(token.expiresIn / 60)}m</span>
              </>
            ) : (
              "Generating token…"
            )}
          </code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleCopy}
            disabled={!token}
            style={{ alignSelf: "flex-start" }}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <p className="text-label" style={{ color: "var(--fg-4)", margin: 0 }}>
          Single-use · regenerates the previous one.
        </p>

        {phase === "waiting" && (
          <div
            className="flex items-center text-body"
            style={{
              gap: "var(--sp-2_5)",
              padding: "var(--sp-2_5) var(--sp-3)",
              background: "color-mix(in oklch, var(--state-blocked) 14%, transparent)",
              border: "var(--hairline) solid color-mix(in oklch, var(--state-blocked) 35%, transparent)",
              borderRadius: "var(--radius-input)",
              color: "color-mix(in oklch, var(--state-blocked) 35%, var(--fg))",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 12,
                height: 12,
                flexShrink: 0,
                borderRadius: "50%",
                border: "var(--hairline-bold) solid color-mix(in oklch, var(--state-blocked) 30%, transparent)",
                borderTopColor: "var(--state-blocked)",
                animation: "spin 0.85s linear infinite",
              }}
            />
            Waiting for your computer to connect…
          </div>
        )}

        {phase === "success" && (
          <div
            className="flex items-center text-body"
            style={{
              gap: "var(--sp-2_5)",
              padding: "var(--sp-2_5) var(--sp-3)",
              background: "color-mix(in oklch, var(--state-idle) 14%, transparent)",
              border: "var(--hairline) solid color-mix(in oklch, var(--state-idle) 35%, transparent)",
              borderRadius: "var(--radius-input)",
              color: "color-mix(in oklch, var(--state-idle) 45%, var(--fg))",
            }}
          >
            <Check className="h-3.5 w-3.5" style={{ flexShrink: 0 }} />
            <span>
              <span className="font-semibold">{arrivedHostname ?? "Computer"}</span> connected. Closing…
            </span>
          </div>
        )}

        {phase === "error" && errorMessage && (
          <div
            className="text-body"
            style={{
              padding: "var(--sp-2_5) var(--sp-3)",
              background: "color-mix(in oklch, var(--state-error) 12%, transparent)",
              border: "var(--hairline) solid color-mix(in oklch, var(--state-error) 28%, transparent)",
              borderRadius: "var(--radius-input)",
              color: "var(--state-error)",
            }}
          >
            {errorMessage}
          </div>
        )}

        <div className="flex justify-end" style={{ gap: "var(--sp-2)" }}>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
