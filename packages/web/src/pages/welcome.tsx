import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../api/client.js";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";

/**
 * Two-step onboarding wizard. The step is read from `/me`'s `wizard.step`
 * field — itself an inference over `clients` + `agents` rows, NOT a
 * persisted column. That means deleting the client/agent automatically
 * rewinds the wizard, which keeps the UX honest about real state.
 *
 * Step 1: prompt CLI install + connect; poll `/me` until the step
 *   advances (= the client checked in).
 *
 * Step 2: single-field "agent name" form; submit creates the agent and
 *   pins it to the just-connected client.
 */
export function WelcomePage() {
  const { wizardStep, refreshMe } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (wizardStep === "completed") {
      navigate("/", { replace: true });
    }
  }, [wizardStep, navigate]);

  if (wizardStep === null || wizardStep === "completed") {
    return <Centered>Loading…</Centered>;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-xl space-y-4">
        {wizardStep === "connect" ? <ConnectStep onAdvance={refreshMe} /> : <CreateAgentStep onAdvance={refreshMe} />}
        <p className="text-center text-label text-muted-foreground">
          We've created your personal team. You can invite teammates later or join an existing team.
        </p>
      </div>
    </div>
  );
}

function ConnectStep({ onAdvance }: { onAdvance: () => Promise<void> }) {
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [secondsWaited, setSecondsWaited] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const generate = async () => {
      try {
        const r = await api.post<{ token: string; expiresIn: number; command: string }>("/connect-tokens");
        if (!cancelled) setToken(r.token);
      } catch {
        // surfaced inline below
      }
    };
    void generate();
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll `/me` every 3s until the wizard step advances.
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      await onAdvance();
      setSecondsWaited((s) => s + 3);
    };
    const handle = setInterval(tick, 3000);
    return () => {
      stopped = true;
      clearInterval(handle);
    };
  }, [onAdvance]);

  const command = token ? `npm install -g @agent-team-foundation/first-tree-hub\nfirst-tree-hub connect ${token}` : "";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-title">Connect your computer</CardTitle>
        <CardDescription>
          Run these two commands in a terminal on the machine that will host your agents.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <pre className="whitespace-pre-wrap rounded-md bg-muted p-3 text-label font-mono">
          {command || "Generating token…"}
        </pre>
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
        <p className="text-label text-muted-foreground">
          Waiting for your computer to check in…
          {secondsWaited >= 60 && (
            <>
              <br />
              Still waiting? Check that you ran the second command in the same terminal.
            </>
          )}
        </p>
      </CardContent>
    </Card>
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
      // We post to admin/agents — admins are the only role that hits this
      // wizard. Members skip directly to the dashboard.
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
    <Card>
      <CardHeader>
        <CardTitle className="text-title">Create your first agent</CardTitle>
        <CardDescription>Pick a short name. You can rename or add more agents later.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-3" onSubmit={handleSubmit}>
          {error && <div className="rounded-md bg-destructive/10 p-2 text-label text-destructive">{error}</div>}
          <div className="space-y-1">
            <Label htmlFor="agent-name">Agent name</Label>
            <Input
              id="agent-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-first-agent"
              autoFocus
            />
          </div>
          <Button type="submit" className="w-full" disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create agent"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-body text-muted-foreground">
      {children}
    </div>
  );
}
