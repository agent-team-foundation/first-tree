import type { InvitationPreview } from "@agent-team-foundation/first-tree-hub-shared";
import { Github } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "../api/client.js";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";

/**
 * Public landing for `/invite/:token`. Two cases:
 *
 *   - Visitor not signed in: show the org name + a "Continue with GitHub"
 *     button that round-trips through OAuth and lands them inside the team.
 *   - Visitor already signed in: surface a "Join now" button that POSTs
 *     `/me/organizations/join` and switches their token over.
 *
 * The preview only exposes org name + display name + role — the public
 * endpoint deliberately does NOT leak member counts, emails, or billing.
 */
export function InviteAcceptPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { isAuthenticated, adoptTokens } = useAuth();
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    void (async () => {
      try {
        const res = await fetch(`/api/v1/invite/${encodeURIComponent(token)}/preview`);
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(body.error ?? "This invitation is no longer valid");
          return;
        }
        setPreview((await res.json()) as InvitationPreview);
      } catch {
        setError("Network error while loading invitation");
      }
    })();
  }, [token]);

  if (!token) return <Centered>Bad invitation URL</Centered>;
  if (error) return <Centered>{error}</Centered>;
  if (!preview) return <Centered>Loading…</Centered>;

  const handleJoin = async () => {
    if (!token) return;
    setBusy(true);
    try {
      const res = await api.post<{
        organizationId: string;
        memberId: string;
        role: string;
        tokens: { accessToken: string; refreshToken: string };
      }>("/me/organizations/join", { token });
      await adoptTokens(res.tokens);
      // Land on dashboard; onboarding modal layers on top if wizard incomplete.
      window.sessionStorage.setItem("onboarding:autoOpen", "1");
      window.sessionStorage.setItem("onboarding:joinPath", "invite");
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to join team");
    } finally {
      setBusy(false);
    }
  };

  const continueOauthHref = `/api/v1/auth/github/start?next=${encodeURIComponent(`/invite/${token}`)}`;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-title">Join {preview.organizationDisplayName}</CardTitle>
          <CardDescription>
            You've been invited as a {preview.role}.
            <br />
            <span className="text-muted-foreground">team: {preview.organizationName}</span>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isAuthenticated ? (
            <Button className="w-full" disabled={busy} onClick={handleJoin}>
              {busy ? "Joining…" : `Join ${preview.organizationDisplayName}`}
            </Button>
          ) : (
            <Button asChild className="w-full">
              <a href={continueOauthHref}>
                <Github className="h-4 w-4" />
                Continue with GitHub to join
              </a>
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-body text-muted-foreground">
      {children}
    </div>
  );
}
