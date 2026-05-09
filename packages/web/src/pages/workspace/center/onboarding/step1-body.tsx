import type { OrgBrief } from "@agent-team-foundation/first-tree-hub-shared";
import { ArrowRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../../../api/client.js";
import { reportOnboardingEvent } from "../../../../api/onboarding-events.js";
import { Button } from "../../../../components/ui/button.js";

export function Step1Body({ organizationId, onContinue }: { organizationId: string | null; onContinue: () => void }) {
  const [orgs, setOrgs] = useState<OrgBrief[]>([]);
  const [name, setName] = useState("");
  const [initialName, setInitialName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Distinguish "still loading the seed name" from "loaded but the user
  // emptied the input" — without this distinction we can't tell whether
  // to disable Continue defensively (load failed → don't let them PATCH a
  // typed-by-hand name that overwrites the auto-generated default they
  // never saw).
  const [orgsLoaded, setOrgsLoaded] = useState(false);
  const [orgsLoadError, setOrgsLoadError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const list = await api.get<OrgBrief[]>("/me/organizations");
        setOrgs(list);
      } catch (err) {
        setOrgsLoadError(err instanceof Error ? err.message : "Failed to load your team");
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

  // Focus the input + place caret at end once the seed value lands (per §5.1).
  useEffect(() => {
    const el = inputRef.current;
    if (!el || !initialName) return;
    el.focus();
    const len = el.value.length;
    el.setSelectionRange(len, len);
  }, [initialName]);

  const trimmed = name.trim();
  // Refuse to submit while orgs haven't loaded (we don't know the seed) or
  // while the load errored out (the user is staring at an empty input we
  // can't seed — letting them PATCH would overwrite the auto-generated
  // name they never saw).
  const canSubmit = trimmed.length > 0 && !saving && orgsLoaded && !orgsLoadError;

  const handleSubmit = useCallback(
    async (event?: React.FormEvent) => {
      event?.preventDefault();
      if (!canSubmit || !organizationId) return;
      setError(null);
      try {
        const renamed = trimmed !== initialName.trim();
        if (renamed) {
          setSaving(true);
          await api.patch(`/orgs/${encodeURIComponent(organizationId)}`, {
            displayName: trimmed,
          });
          void reportOnboardingEvent("team_renamed");
        }
        onContinue();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to rename team");
      } finally {
        setSaving(false);
      }
    },
    [canSubmit, organizationId, trimmed, initialName, onContinue],
  );

  return (
    <form onSubmit={handleSubmit} className="flex flex-col" style={{ gap: "var(--sp-5)" }}>
      <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
        Name your <span style={{ color: "var(--fg-2)" }}>agent team</span> — where humans and AIs collaborate.
      </p>

      <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
        <label htmlFor="onboarding-team-name" className="text-label" style={{ color: "var(--fg-3)" }}>
          Team name
        </label>
        <input
          ref={inputRef}
          id="onboarding-team-name"
          aria-label="Team display name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={200}
          disabled={saving}
          className="text-body"
          style={{
            padding: "var(--sp-2) var(--sp-3)",
            background: "var(--bg)",
            border: "var(--hairline) solid var(--border)",
            borderRadius: "var(--radius-input)",
            color: "var(--fg)",
            outline: "none",
            caretColor: "var(--accent)",
          }}
          onFocus={(event) => {
            event.currentTarget.style.borderColor = "var(--accent)";
          }}
          onBlur={(event) => {
            event.currentTarget.style.borderColor = "var(--border)";
          }}
        />
      </div>

      {error || orgsLoadError ? (
        <div
          className="text-body"
          style={{
            padding: "var(--sp-2_5) var(--sp-3)",
            background: "color-mix(in oklch, var(--state-error) 12%, transparent)",
            border: "var(--hairline) solid color-mix(in oklch, var(--state-error) 28%, transparent)",
            borderRadius: "var(--radius-input)",
            color: "var(--state-error)",
          }}
        >
          {error ?? `Couldn't load your team — ${orgsLoadError}. Refresh the page and try again.`}
        </div>
      ) : null}

      <div className="flex justify-end">
        <Button type="submit" disabled={!canSubmit}>
          <span>Continue</span>
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </form>
  );
}
