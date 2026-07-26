import type { OrgBrief } from "@first-tree/shared";
import { ArrowRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../../api/client.js";
import { reportOnboardingEvent } from "../../../api/onboarding-events.js";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { COPY } from "../copy.js";
import { FlowHint } from "../flow-ui.js";
import { useOnboardingFlow } from "../onboarding-flow.js";

/**
 * Admin step 1. The team row already exists (auto-created at sign-in); the
 * name is pre-filled and editable, so this step reads as confirming the team
 * context before connecting a computer. Enter or Continue advances; an
 * unchanged name skips the PATCH entirely.
 */
export function StepTeam() {
  const { organizationId, goNext, reportStepFailure } = useOnboardingFlow();
  const [orgs, setOrgs] = useState<OrgBrief[]>([]);
  const [name, setName] = useState("");
  const [initialName, setInitialName] = useState("");
  const [orgsLoaded, setOrgsLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const list = await api.get<OrgBrief[]>("/me/organizations");
        setOrgs(list);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "Failed to load your team");
        reportStepFailure("team_load_failed", { step: "create-team" });
      } finally {
        setOrgsLoaded(true);
      }
    })();
  }, [reportStepFailure]);

  useEffect(() => {
    const seed = orgs.find((o) => o.id === organizationId)?.displayName ?? "";
    setName(seed);
    setInitialName(seed);
  }, [orgs, organizationId]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el || !initialName) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [initialName]);

  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && !saving && orgsLoaded && !loadError;

  const handleSubmit = useCallback(
    async (event?: React.FormEvent) => {
      event?.preventDefault();
      if (!canSubmit || !organizationId) return;
      setSaveError(null);
      try {
        if (trimmed !== initialName.trim()) {
          setSaving(true);
          await api.patch(`/orgs/${encodeURIComponent(organizationId)}`, { displayName: trimmed });
          void reportOnboardingEvent("team_renamed");
        }
        goNext();
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : "Failed to rename team");
        reportStepFailure("team_rename_failed", { step: "create-team" });
      } finally {
        setSaving(false);
      }
    },
    [canSubmit, organizationId, trimmed, initialName, goNext, reportStepFailure],
  );

  return (
    <form onSubmit={handleSubmit} className="flex flex-col" style={{ width: "100%", gap: "var(--sp-5)" }}>
      <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
        <label htmlFor="onboarding-team-name" className="text-label font-medium" style={{ color: "var(--fg-2)" }}>
          {COPY.team.nameLead}
        </label>
        <Input
          ref={inputRef}
          id="onboarding-team-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={200}
          disabled={saving}
        />

        {(saveError || loadError) && (
          <FlowHint tone="error" role="alert">
            {saveError ?? `Couldn't load your team — ${loadError}. Refresh and try again.`}
          </FlowHint>
        )}
      </div>

      <div className="flex">
        <Button type="submit" disabled={!canSubmit}>
          <span>{COPY.continue}</span>
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </form>
  );
}
