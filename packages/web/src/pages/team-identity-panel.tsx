import type { Organization } from "@agent-team-foundation/first-tree-hub-shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { listMembers } from "../api/members.js";
import { getOrganization, updateOrganization } from "../api/organizations.js";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "../components/ui/button.js";
import { Panel, PanelBody, PanelHeader, PanelTitle } from "../components/ui/panel.js";

const RENAME_HINT_DISMISS_PREFIX = "rename-hint:";

/**
 * Admin-only panel for renaming the team (`organizations.display_name` and
 * the URL slug `organizations.name`). Implements proposal §决策 #17 (rename
 * is a v1 feature) and §决策 #19 (one-shot rename hint when a default
 * "<login>-personal" team grows past one member).
 *
 * The hint banner is intentionally derived client-side from facts already
 * on the wire (org slug + members list + localStorage dismissed flag) —
 * no schema changes, no toast system, no event triggers. Trade-off vs
 * proposal: the hint surfaces "next time admin visits Settings" instead
 * of "instantly when the second member joins" — but the rename form is
 * right here, so the timing miss doesn't cost any clicks.
 */
export function TeamIdentityPanel() {
  const { organizationId } = useAuth();
  const queryClient = useQueryClient();

  const orgQuery = useQuery({
    queryKey: ["organization", organizationId],
    queryFn: () => (organizationId ? getOrganization(organizationId) : Promise.reject(new Error("no org"))),
    enabled: !!organizationId,
  });

  const membersQuery = useQuery({
    queryKey: ["members"],
    queryFn: listMembers,
  });

  const [displayName, setDisplayName] = useState("");
  const [slug, setSlug] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!orgQuery.data) return;
    setDisplayName(orgQuery.data.displayName);
    setSlug(orgQuery.data.name);
  }, [orgQuery.data]);

  const mutation = useMutation({
    mutationFn: () => {
      if (!organizationId || !orgQuery.data) throw new Error("organization not loaded");
      const patch: { name?: string; displayName?: string } = {};
      const trimmedDisplay = displayName.trim();
      const trimmedSlug = slug.trim();
      if (trimmedDisplay && trimmedDisplay !== orgQuery.data.displayName) patch.displayName = trimmedDisplay;
      if (trimmedSlug && trimmedSlug !== orgQuery.data.name) patch.name = trimmedSlug;
      if (Object.keys(patch).length === 0) return Promise.resolve(orgQuery.data);
      return updateOrganization(organizationId, patch);
    },
    onSuccess: (next: Organization) => {
      queryClient.setQueryData(["organization", organizationId], next);
      // /me/organizations cached in UserMenu — bust so the dropdown
      // displayName updates without a reload.
      queryClient.invalidateQueries({ queryKey: ["me-organizations"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    mutation.mutate();
  };

  // Rename-hint visibility (v1 simplified version of proposal §决策 #19):
  //   - admin (this panel is only mounted under the admin tab)
  //   - team slug still ends in "-personal" (auto-provisioned default)
  //   - >= 2 active members in the team
  //   - user hasn't dismissed the hint for THIS org before
  const dismissKey = `${RENAME_HINT_DISMISS_PREFIX}${organizationId ?? "unknown"}:dismissed`;
  const [hintDismissed, setHintDismissed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(dismissKey) === "1";
  });
  const dismissHint = () => {
    window.localStorage.setItem(dismissKey, "1");
    setHintDismissed(true);
  };
  const showRenameHint =
    !hintDismissed &&
    !!orgQuery.data?.name &&
    orgQuery.data.name.endsWith("-personal") &&
    (membersQuery.data?.length ?? 0) >= 2;

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Team identity</PanelTitle>
        <div className="flex items-center gap-1.5">
          {saved && (
            <span className="mono text-caption" style={{ color: "var(--accent-dim)" }}>
              saved
            </span>
          )}
          <Button type="submit" form="team-identity-form" size="xs" disabled={mutation.isPending || !orgQuery.data}>
            <Check className="h-3 w-3" />
            {mutation.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </PanelHeader>
      <PanelBody>
        {showRenameHint && (
          <div
            className="flex items-start justify-between gap-3"
            style={{
              padding: "var(--sp-2_5) var(--sp-3)",
              marginBottom: "var(--sp-3)",
              background: "var(--bg-sunken)",
              border: "var(--hairline) solid var(--border-faint)",
              borderRadius: "var(--radius-input)",
            }}
          >
            <div className="text-label" style={{ color: "var(--fg-2)" }}>
              Heads up — this team is still using its auto-generated name (
              <span className="mono">{orgQuery.data?.name}</span>). Now that you have teammates, you might want to give
              it a friendlier name in the form below.
            </div>
            <button
              type="button"
              aria-label="Dismiss rename hint"
              onClick={dismissHint}
              className="shrink-0"
              style={{ color: "var(--fg-3)", padding: 2, background: "transparent", border: "none", cursor: "pointer" }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {orgQuery.isLoading ? (
          <div className="text-body" style={{ color: "var(--fg-3)" }}>
            Loading…
          </div>
        ) : orgQuery.error ? (
          <div className="text-body" style={{ color: "var(--state-error)" }}>
            {orgQuery.error instanceof Error ? orgQuery.error.message : "Failed to load team"}
          </div>
        ) : (
          <form id="team-identity-form" onSubmit={handleSubmit}>
            <Field
              label="Team name"
              hint="Shown in the team switcher and dashboard header."
              value={displayName}
              onChange={setDisplayName}
            />
            <Field
              label="URL slug"
              hint="Lowercase letters, digits, hyphens. Used in invite URLs."
              value={slug}
              onChange={(v) => setSlug(v.toLowerCase())}
              mono
              pattern="[a-z0-9][a-z0-9-]*"
            />
            {mutation.error instanceof Error && (
              <div className="text-body" style={{ color: "var(--state-error)", marginTop: "var(--sp-2)" }}>
                {mutation.error.message}
              </div>
            )}
          </form>
        )}
      </PanelBody>
    </Panel>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  mono,
  pattern,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (next: string) => void;
  mono?: boolean;
  pattern?: string;
}) {
  return (
    <div
      className="grid items-start gap-5"
      style={{
        gridTemplateColumns: "1fr var(--sp-45)",
        padding: "var(--sp-3_5) 0",
        borderTop: "var(--hairline) solid var(--border-faint)",
      }}
    >
      <div>
        <div className="text-body font-medium" style={{ color: "var(--fg)" }}>
          {label}
        </div>
        <div className="text-label" style={{ color: "var(--fg-3)", marginTop: 2 }}>
          {hint}
        </div>
      </div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        pattern={pattern}
        className={`w-full outline-none text-body ${mono ? "mono" : ""}`}
        style={{
          padding: "var(--sp-1_25) var(--sp-2_5)",
          background: "var(--bg-sunken)",
          border: "var(--hairline) solid var(--border)",
          borderRadius: "var(--radius-input)",
          color: "var(--fg)",
        }}
      />
    </div>
  );
}
