import { INVITATION_DEFAULT_TTL_DAYS, type InvitationView } from "@first-tree/shared";
import { useEffect, useState } from "react";
import { api, withOrgAt } from "../api/client.js";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "../components/ui/button.js";
import { useCopyFeedback } from "../lib/use-copy-feedback.js";

/** Render the expiry timestamp as "in N days · 2026/5/6" — both relative
 *  and absolute, so the admin doesn't have to do arithmetic. */
function formatExpiry(iso: string): string {
  const expiresAt = new Date(iso);
  const now = Date.now();
  const msLeft = expiresAt.getTime() - now;
  if (msLeft <= 0) return `expired ${expiresAt.toLocaleDateString()}`;
  const daysLeft = Math.ceil(msLeft / (24 * 60 * 60 * 1000));
  const relative = daysLeft === 1 ? "in less than a day" : `in ${daysLeft} days`;
  return `expires ${relative} · ${expiresAt.toLocaleDateString()}`;
}

/**
 * Body of the org's invite dialog (the surrounding chrome + title live in
 * `InviteDialog`). v1 enforces "one active link per org" via the
 * `uq_invitations_active_per_org` partial unique index, so the UI surfaces a
 * single share URL.
 *
 * Role-forked (issue 836): every member can read and Copy the link, since
 * inviting people is core to every member's job; only admins see Rotate, which
 * revokes the prior link and resets its 7-day (`INVITATION_DEFAULT_TTL_DAYS`)
 * timer.
 */
export function InviteLinkPanel() {
  const { organizationId, role } = useAuth();
  const isAdmin = role === "admin";
  const [invite, setInvite] = useState<InvitationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { status: copyStatus, copy } = useCopyFeedback();
  const copied = copyStatus === "copied";

  useEffect(() => {
    if (!organizationId) return;
    void (async () => {
      try {
        const r = await api.get<InvitationView>(withOrgAt(organizationId, "/invitations"));
        setInvite(r);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load invite link");
      }
    })();
  }, [organizationId]);

  const rotate = async () => {
    if (!organizationId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<InvitationView>(withOrgAt(organizationId, "/invitations/rotate"));
      setInvite(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rotate invite link");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-label text-muted-foreground">
        {isAdmin ? (
          <>
            Anyone with this link can join your team as a member. Links expire after {INVITATION_DEFAULT_TTL_DAYS} days;
            rotating revokes the old link instantly and resets the timer.
          </>
        ) : (
          <>
            Anyone with this link can join your team as a member. Links expire after {INVITATION_DEFAULT_TTL_DAYS} days.
          </>
        )}
      </p>
      {error && (
        <div className="rounded-[var(--radius-panel)] bg-destructive/10 p-2 text-label text-destructive">{error}</div>
      )}
      {invite ? (
        <>
          <div className="flex gap-2">
            <input
              readOnly
              className="flex-1 rounded-[var(--radius-panel)] border bg-muted px-2 py-1 text-label font-mono"
              value={invite.inviteUrl}
            />
            {isAdmin && (
              <Button size="sm" variant="outline" onClick={rotate} disabled={busy}>
                {busy ? "Rotating…" : "Rotate"}
              </Button>
            )}
            <Button size="sm" onClick={() => void copy(invite.inviteUrl)}>
              {copied ? "Copied!" : "Copy"}
            </Button>
          </div>
          <p className="text-label text-muted-foreground">
            Created {new Date(invite.createdAt).toLocaleString()}
            {invite.expiresAt ? ` · ${formatExpiry(invite.expiresAt)}` : " · no expiry"}
          </p>
        </>
      ) : (
        <p className="text-label text-muted-foreground">Loading…</p>
      )}
    </div>
  );
}
