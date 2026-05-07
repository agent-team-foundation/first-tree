import type { Organization } from "@agent-team-foundation/first-tree-hub-shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { getOrganization, updateOrganization } from "../api/organizations.js";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "../components/ui/button.js";
import { FlatSectionHeader } from "../components/ui/flat-section-header.js";

/**
 * Admin-only panel for renaming the team (`organizations.display_name` and
 * the URL slug `organizations.name`). Implements proposal §决策 #17.
 *
 * The auto-provisioned default team's name is the user's GitHub login
 * (slug) and real name (display name) — already a friendly default — so
 * there's no separate "rename hint" surface; admins who want to customize
 * just edit the form below.
 */
export function TeamIdentityPanel() {
  const { organizationId } = useAuth();
  const queryClient = useQueryClient();

  const orgQuery = useQuery({
    queryKey: ["organization", organizationId],
    queryFn: () => (organizationId ? getOrganization(organizationId) : Promise.reject(new Error("no org"))),
    enabled: !!organizationId,
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

  return (
    <section>
      <FlatSectionHeader
        right={
          <div className="flex items-center gap-1.5">
            {saved && (
              <span className="mono text-caption" style={{ color: "var(--accent-dim)" }}>
                saved
              </span>
            )}
            <Button
              type="submit"
              form="team-identity-form"
              size="xs"
              variant="outline"
              disabled={mutation.isPending || !orgQuery.data}
            >
              <Check className="h-3 w-3" />
              {mutation.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        }
      >
        Team identity
      </FlatSectionHeader>
      {orgQuery.isLoading ? (
        <div className="text-body" style={{ color: "var(--fg-3)", padding: "var(--sp-3) var(--sp-1)" }}>
          Loading…
        </div>
      ) : orgQuery.error ? (
        <div className="text-body" style={{ color: "var(--state-error)", padding: "var(--sp-3) var(--sp-1)" }}>
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
    </section>
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
        padding: "var(--sp-3_5) var(--sp-1)",
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
