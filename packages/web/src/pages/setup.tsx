import { type FormEvent, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import type { ApiError } from "../api/client.js";
import { createWorkspace, joinWorkspace } from "../api/workspaces.js";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { slugifyWorkspace } from "../utils/workspace-slug.js";

/**
 * `/setup` — the Create / Join modal carrier per design doc §4.4. Two
 * forms in one card, separated by an `or` divider. Both submit to the
 * same `signInWithTokens` flow on success: the server returns a fresh
 * per-org JWT pair scoped to the chosen workspace, and we drop the
 * caller into `/welcome` (PR #4 wires the wizard) or `/` (regular app).
 *
 * This page is the only frontend gate for "user has no workspace yet" —
 * `RequireAuth` lets them through, the route's own `isRootless` check
 * keeps them here. Existing per-org users hitting `/setup` directly
 * (e.g. via "+ Create another workspace" in PR #5) ALSO use this same
 * page; the layout / nav matters more than the gate.
 */
export function SetupPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { isAuthenticated, signInWithTokens } = useAuth();

  if (!isAuthenticated) {
    // Same-domain bounce — preserve the original `next` so a deep-linked
    // /invite that funneled here is honoured after sign-in.
    const next = searchParams.get("next") ?? "/setup";
    return <Navigate to={`/signup?next=${encodeURIComponent(next)}`} replace />;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-lg">
        <CardHeader className="text-center">
          <CardTitle className="text-title">Get started with First Tree Hub</CardTitle>
          <CardDescription>Create your workspace, or join one your team has already set up.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <CreateWorkspaceForm onSuccess={(t) => signInWithTokens(t).then(() => navigate("/", { replace: true }))} />
          <Divider />
          <JoinWorkspaceForm onSuccess={(t) => signInWithTokens(t).then(() => navigate("/", { replace: true }))} />
        </CardContent>
      </Card>
    </div>
  );
}

function Divider() {
  return (
    <div className="relative">
      <div className="absolute inset-0 flex items-center">
        <span className="w-full border-t border-border" />
      </div>
      <div className="relative flex justify-center">
        <span className="bg-card px-2 text-caption uppercase text-muted-foreground">or</span>
      </div>
    </div>
  );
}

type Tokens = { accessToken: string; refreshToken: string };

function CreateWorkspaceForm({ onSuccess }: { onSuccess: (tokens: Tokens) => void }) {
  const [displayName, setDisplayName] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Auto-suggest a slug from the display name so the user usually doesn't
  // have to touch the second field. Lowercase, hyphenated, alphanumeric.
  // Tracks the previously-derived slug so manual edits aren't clobbered
  // by subsequent display-name typing.
  const handleDisplayNameChange = (raw: string) => {
    if (!name || name === slugifyWorkspace(displayName)) {
      setName(slugifyWorkspace(raw));
    }
    setDisplayName(raw);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await createWorkspace({ name, displayName });
      onSuccess({ accessToken: res.accessToken, refreshToken: res.refreshToken });
    } catch (err) {
      setError(translateError(err, "Could not create workspace"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <h3 className="text-body font-medium">I'm the admin · Create our workspace</h3>
      <div className="space-y-2">
        <Label htmlFor="ws-display-name">Workspace name</Label>
        <Input
          id="ws-display-name"
          value={displayName}
          onChange={(e) => handleDisplayNameChange(e.target.value)}
          placeholder="Acme Engineering"
          required
          autoFocus
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="ws-slug" className="text-caption text-muted-foreground">
          URL slug
        </Label>
        <Input
          id="ws-slug"
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase())}
          placeholder="acme-engineering"
          pattern="^[a-z0-9][a-z0-9-]*$"
          required
        />
      </div>
      {error && <div className="rounded-md bg-destructive/10 p-2 text-body text-destructive">{error}</div>}
      <Button type="submit" disabled={busy} className="w-full">
        {busy ? "Creating…" : "Create workspace"}
      </Button>
    </form>
  );
}

function JoinWorkspaceForm({ onSuccess }: { onSuccess: (tokens: Tokens) => void }) {
  const [tokenOrUrl, setTokenOrUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await joinWorkspace({ tokenOrUrl });
      onSuccess({ accessToken: res.accessToken, refreshToken: res.refreshToken });
    } catch (err) {
      setError(translateError(err, "Could not join workspace"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <h3 className="text-body font-medium">I was invited · Join my team</h3>
      <div className="space-y-2">
        <Label htmlFor="invite-link">Paste the invite link your admin shared</Label>
        <Input
          id="invite-link"
          value={tokenOrUrl}
          onChange={(e) => setTokenOrUrl(e.target.value)}
          placeholder="https://first-tree.staging.unispark.dev/invite/…"
          required
        />
      </div>
      {error && <div className="rounded-md bg-destructive/10 p-2 text-body text-destructive">{error}</div>}
      <Button type="submit" disabled={busy} variant="outline" className="w-full">
        {busy ? "Joining…" : "Join workspace"}
      </Button>
    </form>
  );
}

/** Surface the server's user-facing message; otherwise fall back to a generic. */
function translateError(err: unknown, fallback: string): string {
  if (err && typeof err === "object" && "message" in err && typeof (err as ApiError).message === "string") {
    return (err as ApiError).message;
  }
  return fallback;
}
