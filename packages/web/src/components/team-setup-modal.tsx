import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../api/client.js";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog.js";
import { Input } from "./ui/input.js";

/**
 * Modal for creating a new team or joining one via an invite link.
 *
 * Replaces the dedicated `/setup` route. The action prop selects which
 * form to render — `null` keeps the modal closed. On success we adopt
 * the new tokens (which carry the new org context) and reload the
 * dashboard so all per-org queries refetch cleanly.
 */
export function TeamSetupModal({ action, onClose }: { action: "create" | "join" | null; onClose: () => void }) {
  const open = action !== null;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{action === "join" ? "Join a team" : "Create a new team"}</DialogTitle>
          <DialogDescription>
            {action === "join"
              ? "Paste the invite token shared with you."
              : "You'll be the admin. You can rename or invite teammates afterward."}
          </DialogDescription>
        </DialogHeader>
        {action === "create" && <CreateForm onDone={onClose} />}
        {action === "join" && <JoinForm onDone={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Server-side slug rules (membership.ts:sanitizeOrgSlug): lowercase,
 * alphanumeric + hyphens, leading/trailing hyphens stripped, max 40 chars.
 * Mirror that here so we can derive a slug from the display name without
 * surfacing it to the user. Server has its own collision-disambiguation
 * (pickAvailableOrgSlug), so any reasonable slug is safe to send.
 */
function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "team"
  );
}

function CreateForm({ onDone }: { onDone: () => void }) {
  const { selectOrganization } = useAuth();
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Reset state on each open
  useEffect(() => {
    setDisplayName("");
    setError(null);
    setBusy(false);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = displayName.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{
        organization: { id: string; name: string; displayName: string; role: string };
      }>("/me/organizations", { name: slugify(trimmed), displayName: trimmed });
      // The caller is already authenticated and the user JWT is org-agnostic,
      // so no token adoption is needed (the endpoint returns none). Select the
      // freshly created org so the user lands in it.
      await selectOrganization(res.organization.id);
      onDone();
      // A newly created team starts a fresh setup lifecycle. Enter the
      // onboarding route directly so account-level dismissals from another
      // team cannot strand the user on an empty workspace.
      navigate("/onboarding", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create team");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="space-y-3" onSubmit={submit}>
      {error && (
        <div className="rounded-[var(--radius-panel)] bg-destructive/10 p-2 text-label text-destructive">{error}</div>
      )}
      <Input
        id="team-display-name"
        aria-label="Team name"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        placeholder="Acme Robotics"
        autoFocus
      />
      <Button type="submit" className="w-full" disabled={busy || !displayName.trim()}>
        {busy ? "Creating…" : "Create team"}
      </Button>
    </form>
  );
}

function JoinForm({ onDone }: { onDone: () => void }) {
  const { selectOrganization } = useAuth();
  const navigate = useNavigate();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setToken("");
    setError(null);
    setBusy(false);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;
    setBusy(true);
    setError(null);
    try {
      // Strip whole invite URLs (e.g. https://first-tree.example/invite/abc) → just the token.
      const raw = token.trim();
      const match = /\/invite\/([^/?#]+)/.exec(raw);
      const justToken = match?.[1] ?? raw;
      const res = await api.post<{
        organizationId: string;
        memberId: string;
        role: string;
      }>("/me/organizations/join", { token: justToken });
      // No token adoption: the endpoint returns none and the user JWT is
      // org-agnostic. Select the joined org so the user lands in it instead of
      // a stale one (and so we never write `undefined` into the token store).
      await selectOrganization(res.organizationId);
      onDone();
      // A joined team may still need this member's computer/agent setup.
      // `/onboarding` bounces back to the workspace when the selected org is
      // already ready, so mature teams are not held in the flow.
      navigate("/onboarding", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to join team");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="space-y-3" onSubmit={submit}>
      {error && (
        <div className="rounded-[var(--radius-panel)] bg-destructive/10 p-2 text-label text-destructive">{error}</div>
      )}
      <Input
        id="join-token"
        aria-label="Invite token or full URL"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="abc123… or https://first-tree.example/invite/abc123"
        autoFocus
      />
      <Button type="submit" className="w-full" disabled={busy || !token.trim()}>
        {busy ? "Joining…" : "Join team"}
      </Button>
    </form>
  );
}
