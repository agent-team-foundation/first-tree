import { ArrowRight } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { COPY, STEP_COPY } from "../copy.js";
import { StepRoadmap, WelcomeHero } from "../flow-ui.js";
import { useOnboardingFlow } from "../onboarding-flow.js";

/**
 * Invitee step 1 — the ceremonial welcome, mirroring the admin opening
 * (StepTeam) via the shared WelcomeHero + StepRoadmap. A centered hero: brand
 * mark, the "Welcome to the team" greeting, a personalized line naming the team
 * they just joined, a light one-line roadmap (this bookend has no progress bar,
 * so it's the only orientation), then the single Get started CTA. No setup work
 * here — joining is the moment; configuring starts on the next step.
 *
 * The shell renders this step in its hero layout (its own title/why suppressed)
 * — see HERO_STEPS in onboarding-shell.tsx.
 */
export function StepWelcome() {
  const { teamDisplayName, goNext } = useOnboardingFlow();
  return (
    <div className="flex flex-col items-center" style={{ width: "100%", gap: "var(--sp-7)" }}>
      <WelcomeHero
        title={STEP_COPY["join-team"].title}
        subtitle={
          <>
            {COPY.invitee.welcomeBody.pre}
            <span className="font-semibold" style={{ color: "var(--fg)" }}>
              {teamDisplayName ?? "your team"}
            </span>
            {COPY.invitee.welcomeBody.post}
          </>
        }
      />
      <StepRoadmap steps={COPY.invitee.nextSteps} />

      {/* The single CTA (no team-name field — they're joining, not creating). */}
      <Button type="button" onClick={goNext} className="justify-center">
        <span>{COPY.getStarted}</span>
        <ArrowRight className="h-4 w-4" />
      </Button>
    </div>
  );
}
