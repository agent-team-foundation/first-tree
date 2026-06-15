import type { Organization } from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import {
  deleteOrganization,
  getOrganization,
  previewOrganizationDeletion,
  updateOrganization,
} from "../api/organizations.js";
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
import { Section } from "../components/ui/section.js";
import { SettingsField, SettingsSaveButton } from "../components/ui/settings-field.js";

/**
 * Admin-only section for renaming the team (`organizations.display_name`).
 * The auto-provisioned default team's name is the user's GitHub real name
 * (display name) — already a friendly default — so there's no separate
 * "rename hint" surface; admins who want to customize just edit the form.
 */
export function TeamIdentityPanel() {
  const { organizationId, refreshMe } = useAuth();
  const queryClient = useQueryClient();

  const orgQuery = useQuery({
    queryKey: ["organization", organizationId],
    queryFn: () => (organizationId ? getOrganization(organizationId) : Promise.reject(new Error("no org"))),
    enabled: !!organizationId,
  });

  const [displayName, setDisplayName] = useState("");
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [saved, setSaved] = useState(false);

  const deletePreviewQuery = useQuery({
    queryKey: ["organization-delete-preview", organizationId],
    queryFn: () => (organizationId ? previewOrganizationDeletion(organizationId) : Promise.reject(new Error("no org"))),
    enabled: !!organizationId && !!orgQuery.data,
  });

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

  const deleteMutation = useMutation({
    mutationFn: () => {
      if (!organizationId) throw new Error("organization not loaded");
      return deleteOrganization(organizationId);
    },
    onSuccess: async () => {
      setDeleteDialogOpen(false);
      setDeleteConfirmation("");
      queryClient.clear();
      await refreshMe();
    },
  });

  const deletionImpact = deletePreviewQuery.data;
  const impactSummary = deletionImpact
    ? `This will remove access for ${deletionImpact.activeMemberCount} active members, archive ${deletionImpact.agentCount} agents, and retain historical chats, messages, settings, and resource records.`
    : "Historical chats, messages, settings, and resource records will be retained.";
  const canOpenDeleteDialog =
    !!deletionImpact && !deletePreviewQuery.isFetching && !deletePreviewQuery.error && !deleteMutation.isPending;
  const canDelete =
    !!orgQuery.data &&
    canOpenDeleteDialog &&
    deleteConfirmation.trim() === orgQuery.data.displayName &&
    !deleteMutation.isPending &&
    !mutation.isPending;
  const handleDeleteDialogOpenChange = (open: boolean) => {
    setDeleteDialogOpen(open);
    if (!open) setDeleteConfirmation("");
  };

  return (
    <>
      <Section title="Identity">
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
              rightSlot={<SettingsSaveButton pending={mutation.isPending} disabled={!orgQuery.data} />}
            />
            {mutation.error instanceof Error && (
              <div className="text-body" style={{ color: "var(--state-error)" }}>
                {mutation.error.message}
              </div>
            )}
          </form>
        )}
      </Section>

      {orgQuery.data && (
        <div id="team-danger-zone">
          <Section title="Danger zone" description="Deleting a team removes it from active access for every member.">
            <div style={{ paddingTop: "var(--sp-3)" }}>
              <div className="text-body" style={{ color: "var(--fg-2)", marginBottom: "var(--sp-4)" }}>
                {deletePreviewQuery.isLoading
                  ? "Loading deletion impact…"
                  : deletePreviewQuery.error instanceof Error
                    ? deletePreviewQuery.error.message
                    : impactSummary}
              </div>
              <Button
                type="button"
                variant="destructive"
                disabled={!canOpenDeleteDialog || mutation.isPending}
                onClick={() => handleDeleteDialogOpenChange(true)}
              >
                Delete team…
              </Button>
            </div>
            <Dialog open={deleteDialogOpen} onOpenChange={handleDeleteDialogOpenChange}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Delete "{orgQuery.data.displayName}"?</DialogTitle>
                  <DialogDescription>
                    This removes the team from active access. Historical records are retained.
                  </DialogDescription>
                </DialogHeader>
                <div className="text-body" style={{ color: "var(--fg-2)" }}>
                  {impactSummary}
                </div>
                <SettingsField
                  label="Team name"
                  hint={`Type ${orgQuery.data.displayName} to confirm.`}
                  value={deleteConfirmation}
                  onChange={setDeleteConfirmation}
                />
                {deleteMutation.error instanceof Error && (
                  <div className="text-body" style={{ color: "var(--state-error)" }}>
                    {deleteMutation.error.message}
                  </div>
                )}
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => handleDeleteDialogOpenChange(false)}>
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={!canDelete}
                    onClick={() => deleteMutation.mutate()}
                  >
                    Delete team
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </Section>
        </div>
      )}
    </>
  );
}
