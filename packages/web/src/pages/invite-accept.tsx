import type { InvitationPreview, OrgBrief } from "@first-tree/shared";
import { ArrowLeft, Github, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api/client.js";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card.js";
import { markOnboardingResume } from "../utils/onboarding-flags.js";

/**
 * Public landing for `/invite/:token`. Two cases:
 *
 *   - Visitor not signed in: "Continue with GitHub" round-trips through OAuth
 *     and lands them inside the team.
 *   - Visitor already signed in: "Join now" POSTs `/me/organizations/join`
 *     and switches their token over.
 *
 * The preview omits anything internal (memberCount, member emails, billing).
 * The page is team-centric on purpose — invite links are shareable URLs that
 * may reach the recipient via channels we don't track, so identifying "who
 * invited you" can mislead. The team is the load-bearing identity.
 *
 * The page owns data + side effects; the three visual states (skeleton, error,
 * and the join card) are extracted as exported presentational components so the
 * DEV onboarding preview can render every state with fixtures.
 */
export function InviteAcceptPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { isAuthenticated, adoptTokens } = useAuth();
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [currentTeamName, setCurrentTeamName] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    void (async () => {
      try {
        const res = await fetch(`/api/v1/invitations/${encodeURIComponent(token)}/preview`);
        if (!res.ok) {
          setError("This invitation is no longer valid");
          return;
        }
        setPreview((await res.json()) as InvitationPreview);
      } catch {
        setError("Network error while loading invitation");
      }
    })();
  }, [token]);

  // For the switch warning we need the current team's displayName, not just
  // the orgId from the JWT. Fetched lazily — no-op for unauthenticated visitors.
  useEffect(() => {
    if (!isAuthenticated) return;
    void (async () => {
      try {
        const orgs = await api.get<OrgBrief[]>("/me/organizations");
        // The /me JWT carries `organizationId`; resolve via the listing so we
        // get the human-readable display name.
        const me = await api.get<{ member: { organizationId: string } }>("/me");
        const current = orgs.find((o) => o.id === me.member.organizationId);
        setCurrentTeamName(current?.displayName ?? null);
      } catch {
        // best-effort — switch warning just stays hidden
      }
    })();
  }, [isAuthenticated]);

  if (!token)
    return (
      <InviteAcceptShell>
        <InviteAcceptError message="Bad invitation URL" />
      </InviteAcceptShell>
    );
  if (error)
    return (
      <InviteAcceptShell>
        <InviteAcceptError message="This invitation is no longer valid" />
      </InviteAcceptShell>
    );
  if (!preview)
    return (
      <InviteAcceptShell>
        <InviteAcceptSkeleton />
      </InviteAcceptShell>
    );

  const handleJoin = async () => {
    setBusy(true);
    try {
      const res = await api.post<{
        organizationId: string;
        memberId: string;
        role: string;
        tokens: { accessToken: string; refreshToken: string };
      }>("/me/organizations/join", { token });
      await adoptTokens(res.tokens);
      markOnboardingResume("invite");
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to join team");
    } finally {
      setBusy(false);
    }
  };

  const continueOauthHref = `/api/v1/auth/github/start?next=${encodeURIComponent(`/invite/${token}`)}`;

  return (
    <InviteAcceptShell>
      <InviteAcceptCard
        preview={preview}
        isAuthenticated={isAuthenticated}
        currentTeamName={currentTeamName}
        busy={busy}
        onJoin={handleJoin}
        oauthHref={continueOauthHref}
      />
    </InviteAcceptShell>
  );
}

/** Full-screen chrome for the invite page: a "back to home" header over the centered card. */
export function InviteAcceptShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="px-4 py-3">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 rounded-[var(--radius-input)] px-2 py-1 text-body text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to home
        </Link>
      </header>
      <div className="flex flex-1 items-center justify-center px-4 pb-16">{children}</div>
    </div>
  );
}

/** The join card. Pure presentational — the page wires `onJoin` / auth state in. */
export function InviteAcceptCard({
  preview,
  isAuthenticated,
  currentTeamName,
  busy,
  onJoin,
  oauthHref,
}: {
  preview: InvitationPreview;
  isAuthenticated: boolean;
  currentTeamName: string | null;
  busy: boolean;
  onJoin: () => void;
  oauthHref: string;
}) {
  const switchingTeam = isAuthenticated && currentTeamName && currentTeamName !== preview.organizationDisplayName;
  const expiresHint = formatExpiresHint(preview.expiresAt);

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="text-center">
        <CardTitle className="text-title">
          You're invited to join
          <br />
          {preview.organizationDisplayName}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {switchingTeam && (
          <div
            className="flex items-start gap-2 rounded-[var(--radius-panel)] p-3 text-label"
            style={{ background: "var(--bg-sunken)", color: "var(--fg-2)" }}
          >
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              You'll switch from <span className="font-medium">{currentTeamName}</span> to{" "}
              <span className="font-medium">{preview.organizationDisplayName}</span>.
            </span>
          </div>
        )}
        {isAuthenticated ? (
          <Button className="w-full" disabled={busy} onClick={onJoin}>
            {busy ? "Joining…" : `Join ${preview.organizationDisplayName}`}
          </Button>
        ) : (
          <Button asChild className="w-full">
            <a href={oauthHref}>
              <Github className="h-4 w-4" />
              Continue with GitHub to join
            </a>
          </Button>
        )}
        {expiresHint && (
          <p
            className="text-center text-label"
            style={{ color: expiresHint.urgent ? "var(--state-error)" : "var(--fg-3)" }}
          >
            {expiresHint.text}
          </p>
        )}
        <p className="text-center text-label text-muted-foreground">
          By continuing you agree to our{" "}
          <a href="/terms" className="underline underline-offset-2 transition-colors hover:text-foreground">
            Terms
          </a>{" "}
          ·{" "}
          <a href="/privacy" className="underline underline-offset-2 transition-colors hover:text-foreground">
            Privacy
          </a>
        </p>
      </CardContent>
    </Card>
  );
}

/** Loading shimmer shown while the invite preview is fetched. */
export function InviteAcceptSkeleton() {
  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="text-center">
        <div className="mx-auto h-5 w-2/3 rounded-[var(--radius-panel)]" style={{ background: "var(--bg-sunken)" }} />
        <div className="mx-auto mt-2 h-5 w-1/2 rounded-[var(--radius-panel)]" style={{ background: "var(--bg-sunken)" }} />
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="h-9 w-full rounded-[var(--radius-panel)]" style={{ background: "var(--bg-sunken)" }} />
        <div className="mx-auto h-3 w-1/3 rounded-[var(--radius-panel)]" style={{ background: "var(--bg-sunken)" }} />
      </CardContent>
    </Card>
  );
}

/** Terminal "invitation invalid" card with a back-to-home action. */
export function InviteAcceptError({ message }: { message: string }) {
  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="text-center">
        <div className="mb-2 flex justify-center text-fg-3">
          <TriangleAlert className="h-6 w-6" />
        </div>
        <CardTitle className="text-title">{message}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-center text-body text-muted-foreground">
          It may have expired or been revoked. Ask the team admin for a fresh link.
        </p>
        <Button asChild variant="outline" className="w-full">
          <Link to="/">
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to home
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * Format the expiry hint shown under the join CTA. Returns null when the link
 * has more than 7 days left (no urgency, no need to show the user the date).
 * Marked `urgent` when under 24 hours so the UI can render it in the
 * destructive color.
 */
export function formatExpiresHint(expiresAt: string | null): { text: string; urgent: boolean } | null {
  if (!expiresAt) return null;
  const target = new Date(expiresAt).getTime();
  if (!Number.isFinite(target)) return null;
  const diffMs = target - Date.now();
  if (diffMs <= 0) return null;

  const minutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 7) return null;
  if (days >= 1) return { text: `Expires in ${days} ${days === 1 ? "day" : "days"}`, urgent: false };
  if (hours >= 1) return { text: `Expires in ${hours} ${hours === 1 ? "hour" : "hours"}`, urgent: true };
  return { text: `Expires in ${Math.max(1, minutes)} ${minutes === 1 ? "minute" : "minutes"}`, urgent: true };
}
