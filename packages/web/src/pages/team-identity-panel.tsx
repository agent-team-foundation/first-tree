import type { Organization } from "@agent-team-foundation/first-tree-hub-shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { getOrganization, updateOrganization } from "../api/organizations.js";
import { useAuth } from "../auth/auth-context.js";
import { Button } from "../components/ui/button.js";
import { SettingsField } from "../components/ui/settings-field.js";
import { SettingsSection } from "../components/ui/settings-section.js";

/**
 * Admin-only section for renaming the team (`organizations.display_name`).
 * The auto-provisioned default team's name is the user's GitHub real name
 * (display name) — already a friendly default — so there's no separate
 * "rename hint" surface; admins who want to customize just edit the form.
 */
export function TeamIdentityPanel({ isFirst = false }: { isFirst?: boolean }) {
  const { organizationId } = useAuth();
  const queryClient = useQueryClient();

  const orgQuery = useQuery({
    queryKey: ["organization", organizationId],
    queryFn: () => (organizationId ? getOrganization(organizationId) : Promise.reject(new Error("no org"))),
    enabled: !!organizationId,
  });

  const [displayName, setDisplayName] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!orgQuery.data) return;
    setDisplayName(orgQuery.data.displayName);
  }, [orgQuery.data]);

  const mutation = useMutation({
    mutationFn: () => {
      if (!organizationId || !orgQuery.data) throw new Error("organization not loaded");
      const trimmedDisplay = displayName.trim();
      if (!trimmedDisplay || trimmedDisplay === orgQuery.data.displayName) return Promise.resolve(orgQuery.data);
      return updateOrganization(organizationId, { displayName: trimmedDisplay });
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
    <SettingsSection title="Identity" isFirst={isFirst}>
      {orgQuery.isLoading ? (
        <div className="text-body" style={{ color: "var(--fg-3)" }}>
          Loading…
        </div>
      ) : orgQuery.error ? (
        <div className="text-body" style={{ color: "var(--state-error)" }}>
          {orgQuery.error instanceof Error ? orgQuery.error.message : "Failed to load team"}
        </div>
      ) : (
        <form onSubmit={handleSubmit}>
          <SettingsField
            label="Team name"
            hint="Shown in the team switcher and dashboard header."
            value={displayName}
            onChange={setDisplayName}
            saved={saved}
            rightSlot={
              <Button type="submit" size="sm" variant="outline" disabled={mutation.isPending || !orgQuery.data}>
                {mutation.isPending ? "Saving…" : "Save"}
              </Button>
            }
          />
          {mutation.error instanceof Error && (
            <div className="text-body" style={{ color: "var(--state-error)" }}>
              {mutation.error.message}
            </div>
          )}
        </form>
      )}
    </SettingsSection>
  );
}
