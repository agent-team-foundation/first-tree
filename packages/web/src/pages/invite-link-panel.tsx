import type { InvitationView } from "@agent-team-foundation/first-tree-hub-shared";
import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card.js";

/**
 * Admin panel for the org's *current* invite link. v1 enforces "one
 * active link per org" via the `uq_invitations_active_per_org` partial
 * unique index, so the UI surfaces a single share URL with a "rotate"
 * action that revokes-and-replaces in one transaction.
 */
export function InviteLinkPanel() {
  const { organizationId } = useAuth();
  const [invite, setInvite] = useState<InvitationView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!organizationId) return;
    void (async () => {
      try {
        const r = await api.get<InvitationView>(`/admin/organizations/${organizationId}/invitations`);
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
      const r = await api.post<InvitationView>(`/admin/organizations/${organizationId}/invitations/rotate`);
      setInvite(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rotate invite link");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invite link</CardTitle>
        <CardDescription>
          Anyone with this link can join your team as a member. Rotating revokes the old link instantly.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <div className="rounded-md bg-destructive/10 p-2 text-label text-destructive">{error}</div>}
        {invite ? (
          <>
            <div className="flex gap-2">
              <input
                readOnly
                className="flex-1 rounded-md border bg-muted px-2 py-1 text-label font-mono"
                value={invite.inviteUrl}
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard.writeText(invite.inviteUrl);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? "Copied!" : "Copy"}
              </Button>
              <Button size="sm" onClick={rotate} disabled={busy}>
                {busy ? "Rotating…" : "Rotate"}
              </Button>
            </div>
            <p className="text-label text-muted-foreground">
              Created {new Date(invite.createdAt).toLocaleString()}
              {invite.expiresAt ? ` · expires ${new Date(invite.expiresAt).toLocaleString()}` : " · no expiry"}
            </p>
          </>
        ) : (
          <p className="text-label text-muted-foreground">Loading…</p>
        )}
      </CardContent>
    </Card>
  );
}
