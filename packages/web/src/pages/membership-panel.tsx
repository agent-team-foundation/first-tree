import type { OrgBrief } from "@agent-team-foundation/first-tree-hub-shared";
import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { leaveOrganization } from "../api/organizations.js";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import { Panel, PanelHeader, PanelTitle } from "../components/ui/panel.js";

/**
 * Self-service "leave this team" panel. Visible to every member regardless
 * of role (proposal §决策 #20: "允许离开（含 last admin）").
 *
 * After a successful leave the local member's tokens are immediately 401
 * (the auth middleware refuses tokens that resolve to `members.status =
 * 'left'` rows). We:
 *   1. POST /me/organizations/leave
 *   2. Look at the user's remaining active memberships
 *      - >=1 left  → switch to the most-recent and refresh
 *      - 0 left    → log out completely
 */
export function MembershipPanel() {
  const { organizationId, selectOrganization, logout } = useAuth();
  const [orgs, setOrgs] = useState<OrgBrief[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const list = await api.get<OrgBrief[]>("/me/organizations");
        setOrgs(list);
      } catch {
        // best-effort — falls through to "this team" fallback copy below
      }
    })();
  }, []);

  const current = orgs.find((o) => o.id === organizationId);
  const teamLabel = current?.displayName ?? "this team";

  const handleLeave = async () => {
    setBusy(true);
    setError(null);
    try {
      await leaveOrganization();
      // Pick the next active membership for an automatic switch. The
      // current org's row is now status='left'; refetch from /me/orgs.
      const remaining = await api.get<OrgBrief[]>("/me/organizations").catch(() => [] as OrgBrief[]);
      const nextOrg = remaining.find((o) => o.id !== organizationId);
      if (nextOrg) {
        // selectOrganization persists the choice in localStorage and
        // refetches /me — no JWT swap (decouple-client-from-identity §4.6).
        await selectOrganization(nextOrg.id);
      } else {
        // No teams left — full sign-out so the user lands on /login cleanly.
        logout();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to leave team");
      setBusy(false);
    }
  };

  return (
    <>
      <Panel>
        <PanelHeader>
          <PanelTitle>Membership</PanelTitle>
        </PanelHeader>
        <div style={{ padding: "var(--sp-3) var(--sp-4) var(--sp-4)" }}>
          <div className="text-body" style={{ color: "var(--fg)" }}>
            You're a member of <span className="font-medium">{teamLabel}</span>.
          </div>
          <div className="text-label text-muted-foreground" style={{ marginTop: 4 }}>
            Leaving removes your access immediately. Your agents stay in the team for history; you can re-join later if
            an admin shares an invite link.
          </div>
          <div style={{ marginTop: "var(--sp-3)" }}>
            <Button variant="destructive" size="sm" onClick={() => setConfirmOpen(true)} disabled={busy}>
              {busy ? "Leaving…" : "Leave team"}
            </Button>
          </div>
          {error && (
            <div className="text-body" style={{ color: "var(--state-error)", marginTop: "var(--sp-2)" }}>
              {error}
            </div>
          )}
        </div>
      </Panel>

      <Dialog open={confirmOpen} onOpenChange={(next) => !busy && setConfirmOpen(next)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Leave {teamLabel}?</DialogTitle>
            <DialogDescription>
              You'll lose access to this team's agents and chats. Your historical messages stay, but you won't be able
              to read or send new ones until an admin re-invites you.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void handleLeave()} disabled={busy}>
              {busy ? "Leaving…" : "Leave team"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
