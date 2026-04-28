import type { OrgBrief } from "@agent-team-foundation/first-tree-hub-shared";
import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { useAuth } from "../auth/auth-context.js";
import { useOnboardingState } from "../hooks/use-onboarding-state.js";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog.js";
import { Input } from "./ui/input.js";

/**
 * Two-step onboarding wizard, presented as a dismissible modal that
 * floats over the dashboard. Replaces the dedicated `/welcome` route.
 *
 * Step is read from `/me`'s `wizard.step` (an inference over
 * clients + agents); polling automatically advances the modal as
 * the user makes progress in their terminal.
 *
 * Copy adapts to the join path (solo signup vs invite redemption),
 * pulled from the sessionStorage flag the OAuth-complete page sets.
 */
export function OnboardingModal() {
  const { isOpen, close, joinPath, step } = useOnboardingState();
  const { refreshMe, organizationId } = useAuth();
  const [orgs, setOrgs] = useState<OrgBrief[]>([]);

  useEffect(() => {
    if (!isOpen) return;
    void (async () => {
      try {
        const list = await api.get<OrgBrief[]>("/me/organizations");
        setOrgs(list);
      } catch {
        // best-effort
      }
    })();
  }, [isOpen]);

  const currentOrg = orgs.find((o) => o.id === organizationId);
  // Strip the "'s Personal Team" suffix from auto-provisioned team names
  // so the user-facing copy doesn't surface that internal label.
  const friendlyTeamName = (currentOrg?.displayName ?? "").replace(/'s Personal Team$/, "'s team");

  const greeting =
    joinPath === "invite" && friendlyTeamName
      ? `You've joined ${friendlyTeamName}.`
      : "Welcome — let's get you set up.";

  return (
    <Dialog open={isOpen} onOpenChange={(next) => !next && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{greeting}</DialogTitle>
          <DialogDescription>
            {step === "connect"
              ? "Connect a computer, then create your first agent."
              : step === "create_agent"
                ? "One more step: create your first agent."
                : "All set!"}
          </DialogDescription>
        </DialogHeader>
        {step === "connect" && <ConnectStep onAdvance={refreshMe} />}
        {step === "create_agent" && <CreateAgentStep onAdvance={refreshMe} />}
      </DialogContent>
    </Dialog>
  );
}

function ConnectStep({ onAdvance }: { onAdvance: () => Promise<void> }) {
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await api.post<{ token: string; expiresIn: number; command: string }>("/connect-tokens", {});
        if (!cancelled) setToken(r.token);
      } catch {
        // surfaced inline
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll /me every 3s so the modal advances when the client checks in.
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      await onAdvance();
    };
    const handle = setInterval(tick, 3000);
    return () => {
      stopped = true;
      clearInterval(handle);
    };
  }, [onAdvance]);

  const command = token ? `npm install -g @agent-team-foundation/first-tree-hub\nfirst-tree-hub connect ${token}` : "";

  return (
    <div className="space-y-3" style={{ minWidth: 0, maxWidth: "100%" }}>
      <div style={{ width: "100%", overflow: "hidden", minWidth: 0 }}>
        <pre
          className="rounded-md bg-muted p-3 text-label font-mono"
          style={{
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            overflowWrap: "anywhere",
            width: "100%",
            minWidth: 0,
            boxSizing: "border-box",
            margin: 0,
          }}
        >
          {command || "Generating token…"}
        </pre>
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={!command}
        onClick={() => {
          void navigator.clipboard.writeText(command);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied!" : "Copy commands"}
      </Button>
      <p className="text-label text-muted-foreground">Waiting for your computer to check in…</p>
    </div>
  );
}

function CreateAgentStep({ onAdvance }: { onAdvance: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/admin/agents", {
        name: name.trim(),
        type: "autonomous_agent",
        displayName: name.trim(),
      });
      await onAdvance();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="space-y-3" onSubmit={handleSubmit}>
      {error && <div className="rounded-md bg-destructive/10 p-2 text-label text-destructive">{error}</div>}
      <Input
        id="onboarding-agent-name"
        aria-label="Agent name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="my-first-agent"
        autoFocus
      />
      <Button type="submit" className="w-full" disabled={busy || !name.trim()}>
        {busy ? "Creating…" : "Create agent"}
      </Button>
    </form>
  );
}
