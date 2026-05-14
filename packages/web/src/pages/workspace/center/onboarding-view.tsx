import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useAuth } from "../../../auth/auth-context.js";
import { readStep1Confirmed, writeStep1Confirmed } from "../../../utils/onboarding-flags.js";
import { isAutoNamedTeam } from "../../../utils/onboarding-team-name.js";
import { Step1Body } from "./onboarding/step1-body.js";
import { Step2Body } from "./onboarding/step2-body.js";
import { Step3IntroBody } from "./onboarding/step3-intro-body.js";

/**
 * Inline onboarding panel — body branches on `onboardingStep` + URL state +
 * a per-tab session-storage flag for the Step 1 acknowledgement, per
 * docs/new-user-onboarding-design.md §4.2 / §9.
 *
 *   stepOverride "team"  → Step1Body  (team rename)
 *   no override + step1 unconfirmed + onboardingStep "connect" + team
 *     still carries the auto-generated default name + caller is admin
 *                        → Step1Body
 *   onboardingStep "connect" / "create_agent"
 *                        → Step2Body  (agent form + computer connect)
 *   onboardingStep "completed"
 *                        → Step3IntroBody  (CTA "Set up first-tree?")
 *
 * Step 1's visibility is now derived from team state rather than the
 * per-tab `sessionStorage.joinPath` flag (lossy across tabs/devices, can
 * desync from server reality). The new gate keys off `teamDisplayName ===
 * "${login}'s team"` — the literal default minted by `completeOauthFlow`
 * for fresh signups. A renamed team falls through to Step 2, and an
 * invitee whose team already carries a renamed (or even still-default
 * but admin-owned) label also falls through because they aren't admin.
 * sessionStorage `joinPath` is still WRITTEN by `oauth-complete` for
 * telemetry tagging but no longer drives any routing decision here.
 *
 * Visibility of this view is gated by `CenterPanel`:
 * `onboardingStep !== null && !onboardingDismissedAt`. "I'll do it later"
 * and the stepper `✕` both PATCH `onboardingDismissedAt = now()` (and emit
 * a toast pointing at Settings → Setup), so dismiss behaviour is uniform —
 * server-side and cross-tab. There is no per-tab "dismiss Step 3 intro"
 * state any more.
 *
 * The OnboardingStepper at the workspace-shell level renders independently
 * (visibility tied to `users.onboarding_dismissed_at`, not `onboardingStep`).
 * The chat-init transition (sub-state B) is handled by `CenterPanel` routing —
 * once `?c=<chatId>` is set, this view doesn't render at all.
 *
 * Per-step bodies live in `./onboarding/` to keep this file focused on the
 * routing decision; see step1-body.tsx / step2-body.tsx / step3-intro-body.tsx.
 */

type ResolvedBody = "step1" | "step2" | "step3-intro";

export function OnboardingView() {
  const { onboardingStep, refreshMe, organizationId, memberId, role, user, teamDisplayName, orgHasOtherMembers } =
    useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const stepOverride = searchParams.get("step");

  // Step 1 confirmation is a session-only flag — DB rows are pre-created at
  // OAuth time so the server can't distinguish "haven't confirmed yet" from
  // "confirmed days ago". Per-tab is fine: a user who reloads land on the
  // same machine still has the flag.
  const [step1Confirmed, setStep1ConfirmedState] = useState(() => readStep1Confirmed());

  const setStep1Confirmed = useCallback((v: boolean) => {
    writeStep1Confirmed(v);
    setStep1ConfirmedState(v);
  }, []);

  // Step 1's PATCH /orgs/:id is gated by `requireOrgAdmin` server-side, so a
  // non-admin member who somehow lands on Step 1 (lost joinPath flag,
  // clicked the stepper pip) would just hit a 403. Skip Step 1 for them
  // entirely — they joined an existing team and the team-rename pillar
  // doesn't apply.
  const canRenameTeam = role === "admin";

  // Auto-generated default produced by `completeOauthFlow` for a fresh
  // signup is `` `${profile.login}'s team` `` (original GitHub casing).
  // `users.username` is normalized to lowercase though, so the compare
  // happens case-insensitively — see `isAutoNamedTeam` for the full
  // rationale (the lowercase/casing skew is what matters for the typical
  // mixed-case GitHub login; the hex-suffix collision branch is a known
  // accepted false negative). PR #377 review caught the case-sensitivity
  // regression.
  const login = user?.username ?? null;
  const teamHasDefaultName = isAutoNamedTeam(teamDisplayName, login);

  const body = useMemo<ResolvedBody>(() => {
    if (stepOverride === "team" && canRenameTeam) return "step1";
    if (stepOverride === "agent") return "step2";
    if (stepOverride === "tree") return "step3-intro";
    if (onboardingStep === "completed") return "step3-intro";
    if (onboardingStep === "connect" && !step1Confirmed && canRenameTeam && teamHasDefaultName) {
      return "step1";
    }
    return "step2";
  }, [stepOverride, onboardingStep, step1Confirmed, canRenameTeam, teamHasDefaultName]);

  const advanceToStep2 = useCallback(() => {
    setStep1Confirmed(true);
    const next = new URLSearchParams(searchParams);
    next.delete("step");
    setSearchParams(next, { replace: true });
  }, [setStep1Confirmed, searchParams, setSearchParams]);

  return (
    <div
      className="flex-1 overflow-auto"
      style={{
        display: "flex",
        justifyContent: "center",
        padding: "clamp(var(--sp-16), 12vh, var(--sp-45)) var(--sp-4) var(--sp-12)",
      }}
    >
      <div style={{ width: "100%", maxWidth: 720 }}>
        {body === "step1" ? (
          <Step1Body organizationId={organizationId} onContinue={advanceToStep2} />
        ) : body === "step2" ? (
          <Step2Body
            organizationId={organizationId}
            memberId={memberId}
            orgHasOtherMembers={orgHasOtherMembers}
            refreshMe={refreshMe}
          />
        ) : (
          <Step3IntroBody />
        )}
      </div>
    </div>
  );
}
