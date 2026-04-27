import { ONBOARDING_STEPS } from "@agent-team-foundation/first-tree-hub-shared";
import { type FormEvent, useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { listMyClients } from "../api/clients.js";
import { createWizardAgent, setOnboardingState } from "../api/onboarding.js";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";

/**
 * `/welcome/agent` — second wizard screen per design doc §4.5.2.
 *
 * Single-field form: agent name. We pin the new agent to the user's
 * first connected client (must exist by step 2 — the polling on
 * `/welcome/connect` only advanced when one appeared) and default the
 * type to `autonomous_agent`. PR #6 / a follow-up can surface
 * type/visibility toggles; the wizard's job is to get the user from
 * "0 agents" to "1 agent" with minimum friction.
 *
 * On success: PATCH `/me/onboarding-state` to `completed` then navigate
 * to `/`. The state write blocks the navigate so the regular shell
 * doesn't re-bounce the user back into the wizard via stale state.
 */
export function WelcomeAgentPage() {
  const navigate = useNavigate();
  const { onboardingState, refetchAll } = useAuth();
  const [name, setName] = useState("my-agent");
  const [clientId, setClientId] = useState<string | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Resolve the user's first connected client. The Connect screen
  // already guaranteed at least one exists; we re-fetch here rather
  // than threading the value through navigation state so a refresh
  // mid-wizard works.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await listMyClients();
        const connected = list.find((c) => c.status === "connected");
        if (cancelled) return;
        if (!connected) {
          setClientError("No connected machine found. Go back to step 1.");
          return;
        }
        setClientId(connected.id);
      } catch (err) {
        if (!cancelled) setClientError(err instanceof Error ? err.message : "Could not load clients");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // If the wizard is already marked completed (e.g. user refreshed
  // /welcome/agent post-completion), bounce them out — replaying the
  // wizard would create a duplicate agent.
  if (onboardingState?.currentStep === ONBOARDING_STEPS.COMPLETED) {
    return <Navigate to="/" replace />;
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!clientId) return;
    setSubmitError(null);
    setBusy(true);
    try {
      await createWizardAgent({
        name,
        displayName: name,
        type: "autonomous_agent",
        clientId,
      });
      await setOnboardingState({ currentStep: ONBOARDING_STEPS.COMPLETED });
      // Refetch member context so the in-memory `onboardingState` matches
      // the server before the next route transition runs its gate check.
      await refetchAll();
      navigate("/", { replace: true });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Could not create agent");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle className="text-title">Create your first agent</CardTitle>
          <CardDescription>
            One agent per task. Pick a name (you can rename later); we'll spin it up on your connected machine.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {clientError ? (
            <div className="space-y-3">
              <div className="rounded-md bg-destructive/10 p-2 text-body text-destructive">{clientError}</div>
              <Button variant="outline" onClick={() => navigate("/welcome/connect", { replace: true })}>
                Back to step 1
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="agent-name">Agent name</Label>
                <Input
                  id="agent-name"
                  value={name}
                  onChange={(e) => setName(e.target.value.toLowerCase())}
                  placeholder="my-agent"
                  pattern="^[a-z0-9][a-z0-9_-]{0,63}$"
                  required
                  autoFocus
                />
                <p className="text-caption text-muted-foreground">
                  Lowercase letters, digits, hyphens. Must start with a letter or digit.
                </p>
              </div>
              {submitError && (
                <div className="rounded-md bg-destructive/10 p-2 text-body text-destructive">{submitError}</div>
              )}
              <div className="flex justify-end gap-2">
                <Button type="submit" disabled={busy || !clientId}>
                  {busy ? "Creating…" : "Create agent"}
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
