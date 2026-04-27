import type { InvitePreview } from "@agent-team-foundation/first-tree-hub-shared";
import { useEffect, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { joinWorkspace, previewInvite } from "../api/workspaces.js";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";

/**
 * `/invite/:token` landing per design doc §4.3. Public preview first
 * (workspace name visible without auth so the user knows what they're
 * joining), then either:
 *
 *   * Not signed in → "Sign in with GitHub to join" — bounces through
 *     `/signup?next=/invite/<token>`. The server preserves `next` across
 *     OAuth and lands the user back here authed.
 *   * Signed in → "Join Acme Engineering" → POST /me/workspaces/join,
 *     swap tokens, redirect to `/`. Idempotent on the backend so a
 *     re-clicked link doesn't 409.
 *
 * 404 from preview surfaces the design-doc string verbatim:
 *   "This invite link isn't valid. Ask your admin for the correct link."
 */
export function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { isAuthenticated, signInWithTokens } = useAuth();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    if (!token) return;
    // `cancelled` flag rather than AbortController — `previewInvite` uses
    // the shared `fetch` which doesn't expose a signal threading API
    // here. Effect dropping the result of a stale request avoids the
    // "set state on unmounted component" silent flash without needing
    // to re-plumb the network layer.
    let cancelled = false;
    previewInvite(token)
      .then((preview) => {
        if (!cancelled) setPreview(preview);
      })
      .catch((err: unknown) => {
        if (!cancelled) setPreviewError(err instanceof Error ? err.message : "Could not load invite");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (!token) {
    return <Navigate to="/signup" replace />;
  }

  const handleJoin = async () => {
    if (!token) return;
    setJoinError(null);
    setJoining(true);
    try {
      const res = await joinWorkspace({ tokenOrUrl: token });
      await signInWithTokens({ accessToken: res.accessToken, refreshToken: res.refreshToken });
      navigate("/", { replace: true });
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : "Could not join workspace");
    } finally {
      setJoining(false);
    }
  };

  if (previewError) {
    return (
      <CenteredCard
        title="Invite link unavailable"
        description="This invite link isn't valid. Ask your admin for the correct link."
      />
    );
  }

  if (!preview) {
    return <CenteredCard title="Loading invite…" description="" />;
  }

  if (!isAuthenticated) {
    return (
      <CenteredCard
        title={`Join ${preview.organizationDisplayName}`}
        description="Sign in with GitHub to accept this invite."
      >
        <Button asChild className="w-full">
          <a href={`/signup?next=${encodeURIComponent(`/invite/${token}`)}`}>Continue with GitHub</a>
        </Button>
      </CenteredCard>
    );
  }

  return (
    <CenteredCard
      title={`Join ${preview.organizationDisplayName}`}
      description={`You'll be added as a member of ${preview.organizationSlug}.`}
    >
      {joinError && <div className="rounded-md bg-destructive/10 p-2 text-body text-destructive">{joinError}</div>}
      <Button onClick={handleJoin} disabled={joining} className="w-full">
        {joining ? "Joining…" : "Join workspace"}
      </Button>
    </CenteredCard>
  );
}

function CenteredCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-title">{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        {children && <CardContent className="space-y-4">{children}</CardContent>}
      </Card>
    </div>
  );
}
