import { useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { api } from "../api/client.js";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";

/**
 * `/setup` page — entry point both for "create another team" and "join via
 * invite link". The `?action=create|join` query selects the form; default
 * is `create`. Used by the `OrganizationSwitcher` dropdown.
 */
export function TeamSetupPage() {
  const { isAuthenticated } = useAuth();
  const [params] = useSearchParams();
  if (!isAuthenticated) return <Navigate to="/login" replace />;

  const action = params.get("action") === "join" ? "join" : "create";
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md">{action === "join" ? <JoinForm /> : <CreateForm />}</div>
    </div>
  );
}

function CreateForm() {
  const { adoptTokens } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !displayName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{
        organization: { id: string; name: string; displayName: string; role: string };
        tokens: { accessToken: string; refreshToken: string };
      }>("/me/organizations", { name: name.trim(), displayName: displayName.trim() });
      await adoptTokens(res.tokens);
      navigate("/welcome", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create team");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create a new team</CardTitle>
        <CardDescription>You'll be the admin. You can rename or invite teammates afterward.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-3" onSubmit={submit}>
          {error && <div className="rounded-md bg-destructive/10 p-2 text-label text-destructive">{error}</div>}
          <div className="space-y-1">
            <Label htmlFor="team-display-name">Team name</Label>
            <Input
              id="team-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Acme Robotics"
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="team-slug">Team URL slug</Label>
            <Input
              id="team-slug"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder="acme"
              pattern="[a-z0-9][a-z0-9-]*"
            />
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Creating…" : "Create team"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function JoinForm() {
  const { adoptTokens } = useAuth();
  const navigate = useNavigate();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{
        tokens: { accessToken: string; refreshToken: string };
      }>("/me/organizations/join", { token: token.trim() });
      await adoptTokens(res.tokens);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to join team");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Join a team</CardTitle>
        <CardDescription>
          Paste the invite token your admin shared. Or visit the full /invite/&lt;token&gt; link.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-3" onSubmit={submit}>
          {error && <div className="rounded-md bg-destructive/10 p-2 text-label text-destructive">{error}</div>}
          <div className="space-y-1">
            <Label htmlFor="join-token">Invite token</Label>
            <Input id="join-token" value={token} onChange={(e) => setToken(e.target.value)} autoFocus />
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Joining…" : "Join team"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
