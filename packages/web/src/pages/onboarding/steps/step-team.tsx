import type { OrgBrief } from "@first-tree/shared";
import { ArrowRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../../api/client.js";
import { reportOnboardingEvent } from "../../../api/onboarding-events.js";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { COPY, STEP_COPY } from "../copy.js";
import { FlowHint, StepRoadmap, WelcomeHero } from "../flow-ui.js";
import { useOnboardingFlow } from "../onboarding-flow.js";

/**
 * Admin step 1 — the ceremonial welcome (the highest-leverage frame in
 * onboarding). A centered "this is a moment" hero: brand mark, greeting, a
 * one-line value subtitle, a light "what's next" roadmap (this bookend has no
 * progress bar, so it's the only orientation), then the single first action —
 * confirm or rename the team. The team row already exists (auto-created at
 * sign-in); the name is pre-filled with a trailing "rename it freely" hint, so
 * naming reads as optional, not a cold required field. Enter or Get started
 * advances; an unchanged name skips the PATCH entirely.
 *
 * The shell renders this step in its hero layout (wider, centered, its own
 * title/why suppressed) — see HERO_STEPS in onboarding-shell.tsx.
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
    <form onSubmit={handleSubmit} className="flex flex-col items-center" style={{ width: "100%", gap: "var(--sp-7)" }}>
      {/* Hero + roadmap are shared with the invitee opening (StepWelcome); the
          greeting reuses the team STEP_COPY strings (the shell suppresses its
          own copy for this hero step). */}
      <WelcomeHero title={STEP_COPY.team.title} subtitle={STEP_COPY.team.why} />
      <StepRoadmap steps={COPY.team.nextSteps} />

      {/* ── Action ── name the field explicitly with a warm question on its own
          line above the input (a bare box left the field's purpose ambiguous),
          then the single primary CTA. */}
      <div className="flex flex-col items-center" style={{ gap: "var(--sp-5)", width: "100%", maxWidth: "22rem" }}>
        <div className="flex flex-col items-center" style={{ gap: "var(--sp-2_5)", width: "100%" }}>
          <label
            htmlFor="onboarding-team-name"
            className="text-label"
            style={{ color: "var(--fg-3)", textAlign: "center" }}
          >
            {COPY.team.nameLead}
          </label>
          {/* Design-system Input (not a hand-rolled box): it carries the
              focus-visible border-ring, so keyboard focus stays visible on the
              first screen's only field. */}
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

        <Button type="submit" disabled={!canSubmit} className="justify-center">
          <span>{COPY.getStarted}</span>
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </form>
  );
}
