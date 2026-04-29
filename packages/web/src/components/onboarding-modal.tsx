import type { OrgBrief } from "@agent-team-foundation/first-tree-hub-shared";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { createAgentChat } from "../api/chats.js";
import { api } from "../api/client.js";
import { useAuth } from "../auth/auth-context.js";
import { useOnboardingState } from "../hooks/use-onboarding-state.js";
import { ConnectCommandPanel } from "./connect-command-panel.js";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog.js";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";

/**
 * Onboarding stepper modal — opened only by user action (banner button or
 * EmptyState "Resume setup"). Two surfaces, one outcome:
 *
 *   Step 1 "Name" — single input. Captures the agent name BEFORE asking
 *                   the user to install anything. The CLI install becomes
 *                   *motivated* ("Connect a computer to run …") instead of
 *                   the modal's first impression being a shell command.
 *
 *   Step 2 "Connect" — only shown when no client is registered yet. Once
 *                      the wizard advances (server detects a checked-in
 *                      client), the modal proceeds automatically: it POSTs
 *                      the agent (with the name from Step 1), opens a chat
 *                      with that agent, and navigates the user into the
 *                      workspace's chat view. Modal closes; the user lands
 *                      in front of an empty input box and types whatever
 *                      they actually want to ask their agent.
 *
 * If the user already has a client (returning user with deleted agent,
 * second sign-in, etc.), Step 2 is skipped — Step 1 leads straight into
 * agent creation + chat + navigate.
 *
 * Magic moment is deliberately NOT a pre-filled "Hello!" message — that's
 * a fake demo. The user types their own first message into the real
 * workspace, exactly as they will every day after.
 */
export function OnboardingModal() {
  const { modalOpen, closeModal, joinPath, step } = useOnboardingState();
  const { refreshMe, organizationId } = useAuth();
  const navigate = useNavigate();
  const [orgs, setOrgs] = useState<OrgBrief[]>([]);

  const [agentName, setAgentName] = useState("");
  const [localStep, setLocalStep] = useState<"name" | "connect" | "creating">("name");
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset local state on open. Server-driven `step` may already be
  // `create_agent` (returning user with a connected client) — we still
  // start at "name" so the user always picks the agent name first.
  useEffect(() => {
    if (!modalOpen) return;
    setAgentName("");
    setLocalStep("name");
    setToken(null);
    setError(null);
  }, [modalOpen]);

  useEffect(() => {
    if (!modalOpen) return;
    void (async () => {
      try {
        const list = await api.get<OrgBrief[]>("/me/organizations");
        setOrgs(list);
      } catch {
        // best-effort; greeting falls back to generic copy
      }
    })();
  }, [modalOpen]);

  const teamName = orgs.find((o) => o.id === organizationId)?.displayName ?? "";
  const greeting = joinPath === "invite" && teamName ? `You've joined ${teamName}.` : "Set up your first agent";

  // Memoized so the auto-advance effect's dep list stays stable —
  // recreating the function each render would refire the effect spuriously.
  const finishOnboarding = useCallback(
    async (name: string): Promise<void> => {
      setLocalStep("creating");
      setError(null);
      try {
        const trimmed = name.trim();
        const agent = await api.post<{ uuid: string }>("/admin/agents", {
          name: trimmed,
          type: "autonomous_agent",
          displayName: trimmed,
        });
        const chat = await createAgentChat(agent.uuid);
        await refreshMe();
        closeModal();
        // Land the user inside the freshly-created chat with an empty input —
        // the natural place to send a real first message.
        navigate(`/?a=${encodeURIComponent(agent.uuid)}&c=${encodeURIComponent(chat.id)}`, { replace: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to create agent");
        // Always fall back to the name step so the user sees the error and
        // chooses whether to retry. NOT the connect step — `finishOnboarding`
        // is only ever entered when `step === "create_agent"` (i.e. a client
        // is registered), so a "connect" fallback would put the user back in
        // a now-pointless install screen AND would let the auto-advance
        // effect immediately re-fire `finishOnboarding`, looping on
        // persistent errors (name collision, server 500, quota).
        setLocalStep("name");
      }
    },
    [refreshMe, closeModal, navigate],
  );

  // When user submits the name input.
  const onSubmitName = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!agentName.trim()) return;
    if (step === "connect") {
      // Need a client first. Surface Step 2.
      setLocalStep("connect");
    } else {
      // Already has a client — go straight to creation.
      await finishOnboarding(agentName);
    }
  };

  // Lazy-load a connect token once we know we'll show Step 2.
  useEffect(() => {
    if (localStep !== "connect" || token) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await api.post<{ token: string; expiresIn: number }>("/connect-tokens", {});
        if (!cancelled) setToken(r.token);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to generate connect token");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [localStep, token]);

  // While in Step 2, poll /me every 3s. When the wizard advances to
  // `create_agent` (server saw a client), kick off agent + chat creation
  // automatically.
  useEffect(() => {
    if (localStep !== "connect") return;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      await refreshMe();
    };
    const handle = setInterval(tick, 3000);
    return () => {
      stopped = true;
      clearInterval(handle);
    };
  }, [localStep, refreshMe]);

  // Auto-advance: client just registered while we were waiting.
  useEffect(() => {
    if (localStep === "connect" && step === "create_agent" && agentName.trim()) {
      void finishOnboarding(agentName);
    }
  }, [localStep, step, agentName, finishOnboarding]);

  const cliCommand = token
    ? `npm install -g @agent-team-foundation/first-tree-hub\nfirst-tree-hub connect ${token}`
    : null;

  return (
    <Dialog open={modalOpen} onOpenChange={(next) => !next && closeModal()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{greeting}</DialogTitle>
          <DialogDescription>
            {localStep === "name"
              ? "What should we call your agent?"
              : localStep === "connect"
                ? `Connect a computer to run "${agentName.trim()}".`
                : "Setting things up…"}
          </DialogDescription>
        </DialogHeader>

        {error && localStep !== "connect" && (
          <div className="rounded-md bg-destructive/10 p-2 text-label text-destructive">{error}</div>
        )}

        {localStep === "name" && (
          <form className="space-y-3" onSubmit={onSubmitName}>
            <div className="space-y-2">
              <Label htmlFor="onboarding-agent-name">Agent name</Label>
              <Input
                id="onboarding-agent-name"
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                placeholder="my-first-agent"
                autoFocus
              />
            </div>
            <Button type="submit" className="w-full" disabled={!agentName.trim()}>
              Continue
            </Button>
          </form>
        )}

        {localStep === "connect" && (
          <ConnectCommandPanel
            command={cliCommand}
            phase={error ? "error" : "waiting"}
            copyLabel={{ idle: "Copy commands", done: "Copied" }}
            waitingText="Waiting for your computer to check in…"
            errorContent={error}
            caption={null}
          />
        )}

        {localStep === "creating" && <p className="text-body text-muted-foreground">Creating your agent…</p>}
      </DialogContent>
    </Dialog>
  );
}
