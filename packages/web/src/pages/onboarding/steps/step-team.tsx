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
 * Admin step 1: confirm or rename the team. The team row already exists
 * (auto-created at sign-in); this just lets the user own its name. One
 * field, pre-filled, Enter or Continue advances. If the name is unchanged
 * we skip the PATCH entirely.
 */
export function StepTeam() {
  const { organizationId, goNext } = useOnboardingFlow();
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
      } finally {
        setOrgsLoaded(true);
      }
    })();
  }, []);

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
      } finally {
        setSaving(false);
      }
    },
    [canSubmit, organizationId, trimmed, initialName, goNext],
  );

  return (
    <form onSubmit={handleSubmit} className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
      {/* The welcome's first action: name the team. A visible label now names
          the field (the step title is the greeting, not the field label), with
          the "shared space" reassurance as a hint underneath. */}
      <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
        <label htmlFor="onboarding-team-name" className="text-label font-medium" style={{ color: "var(--fg-2)" }}>
          {COPY.team.nameLabel}
        </label>
        <Input
          ref={inputRef}
          id="onboarding-team-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={200}
          disabled={saving}
        />
        <p className="text-label" style={{ margin: 0, color: "var(--fg-4)" }}>
          {COPY.team.renameHint}
        </p>
      </div>

      {(saveError || loadError) && (
        <FlowHint tone="error" role="alert">
          {saveError ?? `Couldn't load your team — ${loadError}. Refresh and try again.`}
        </FlowHint>
      )}

      <div className="flex">
        <Button type="submit" disabled={!canSubmit}>
          <span>{COPY.continue}</span>
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </form>
  );
}
