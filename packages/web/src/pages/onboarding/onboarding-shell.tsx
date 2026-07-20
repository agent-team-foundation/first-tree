import { Plus, UserPlus } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../../auth/auth-context.js";
import { showLogoutIncompleteToast } from "../../auth/logout-recovery.js";
import { FirstTreeLogo } from "../../components/first-tree-logo.js";
import { TeamSetupModal } from "../../components/team-setup-modal.js";
import { TeamSwitchOverlay } from "../../components/team-switch-overlay.js";
import { TeamSwitcher } from "../../components/team-switcher.js";
import { Button } from "../../components/ui/button.js";
import { useToast } from "../../components/ui/toast.js";
import { captureBrowserStorageScope } from "../../lib/browser-storage-scope.js";
import { COPY, STEP_COPY } from "./copy.js";
import { useOnboardingFlow } from "./onboarding-flow.js";
import { StepProgress } from "./step-progress.js";

/**
 * Onboarding chrome: a slim top bar (brand + sign out / finish later) over a
 * clean background, then a single centered content column. No card / border /
 * shadow; structure comes from the column itself, top-anchored at a fixed
 * offset so it never jumps as content height changes.
 *
 * Progress lives at the top of the content column (`StepProgress`) rather than
 * in a left rail: at 2 config steps a full-height vertical rail read
 * half-empty and stole horizontal space, fighting the "lighter, less pressure"
 * goal. The column-internal progress also means one layout at every width — no
 * desktop-rail / narrow-eyebrow split.
 *
 * Outcomes (the old "What you'll have" footer) were folded into each step's
 * `why` copy — one place for the user to read, less repetition, less density.
 */
export function OnboardingShell({ children }: { children: ReactNode }) {
  const { activeStep, finishLater, hasAgent } = useOnboardingFlow();
  const { logout, retryLogout, memberships } = useAuth();
  const { addToast } = useToast();
  const navigate = useNavigate();
  const [setupAction, setSetupAction] = useState<"create" | "join" | null>(null);
  const copy = STEP_COPY[activeStep];
  const needsTeam = memberships.length === 0;

  // A multi-team user gets the real TeamSwitcher plus the bare "Sign out" link.
  // The account-only UserMenu is absent from onboarding chrome. The
  // workspace gate routes a returning user into onboarding whenever the
  // SELECTED org has no usable agent, so a user who switches into a
  // not-yet-set-up team lands here with no agent in THIS org ("finish later"
  // hidden below) — without the switcher they had no way back to the team they
  // came from short of signing out. Switching teams via the menu is the same
  // affordance they used to get here, and it carries no dismissal side effect
  // (the account-level dismissal would suppress onboarding for every org).
  // First-run users (single membership) keep the deliberately minimal chrome:
  // the menu's only destinations would fork them into a second team mid-setup.
  const isMultiTeam = memberships.length > 1;
  const signOut = () => {
    const departingScope = captureBrowserStorageScope();
    void Promise.resolve(logout({ scope: departingScope }))
      .then((completed) => {
        if (completed === "incomplete" || completed === undefined) {
          showLogoutIncompleteToast(
            addToast,
            retryLogout ?? (() => logout({ protectReplacementTokens: true, scope: departingScope })),
          );
        }
      })
      .catch(() =>
        showLogoutIncompleteToast(
          addToast,
          retryLogout ?? (() => logout({ protectReplacementTokens: true, scope: departingScope })),
        ),
      );
  };

  return (
    // h-screen + overflow-hidden pins the app to the viewport, so the page can
    // never grow a vertical scrollbar. Long content is bounded by the repo
    // picker's own viewport-relative max-height (it scrolls internally), and the
    // body below has overflow-y:auto only as a last-resort fallback.
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <header className="flex items-center justify-between" style={{ padding: "var(--sp-4) var(--sp-5)" }}>
        <span className="inline-flex items-center" style={{ gap: "var(--sp-2)", color: "var(--fg)" }}>
          <FirstTreeLogo width={22} height={25} />
          <span className="text-label font-semibold">{COPY.productName}</span>
        </span>
        <div className="inline-flex items-center" style={{ gap: "var(--sp-4)" }}>
          {/* "Finish later" only once a teammate exists in THIS org — before
              that the org's workspace is empty, so leaving is a dead end. */}
          {hasAgent && (
            <Button
              type="button"
              variant="link"
              className="h-auto p-0 text-label"
              onClick={() => {
                // Tell the user where setup lives before dropping them into the
                // still-incomplete workspace — otherwise "finish later" reads as
                // "lose my progress". Settings → Setup has the Resume path.
                addToast({
                  title: "Setup paused",
                  description: "Pick up where you left off anytime in Settings → Setup.",
                  action: { label: "Open Settings", onClick: () => navigate("/settings/onboarding") },
                });
                void finishLater();
              }}
            >
              {COPY.finishLater}
            </Button>
          )}
          {/* Multi-team: the real team switcher escape hatch plus account exit.
              First-run: a bare Sign out link, always available so a user who
              can't finish right now isn't locked out. */}
          {isMultiTeam ? (
            <>
              <TeamSwitcher />
              <Button type="button" variant="link" className="h-auto p-0 text-label" onClick={signOut}>
                Sign out
              </Button>
            </>
          ) : (
            <Button type="button" variant="link" className="h-auto p-0 text-label" onClick={signOut}>
              Sign out
            </Button>
          )}
        </div>
      </header>

      {/* Body: a single centered content column, top-anchored at a fixed offset
          (paddingTop) so it sits at the SAME vertical position on every step —
          it never jumps as content height changes. Short steps land in the upper
          third; a tall step fills downward from that same top. The repo picker's
          own max-height keeps even the tallest step on one screen. */}
      <div
        className="flex-1 min-h-0 flex flex-col items-center"
        style={{
          overflowY: "auto",
          // Fixed top-anchor offset for the content column. COUPLED: the repo
          // picker's fill cap in flow-ui.tsx (`calc(100vh - 33rem)`) is tuned to
          // this value — if you change it, re-tune that cap too.
          paddingTop: "6rem",
          paddingBottom: "var(--sp-8)",
          paddingInline: "var(--sp-5)",
        }}
      >
        {/* `maxWidth: 100%` caps the column to the body's content box so, centred
            in a phone-width body under the shell's `overflow-hidden`, both ends
            of every step stay on-screen. On desktop the 34rem width wins and this
            is a no-op. */}
        <main
          className="min-w-0"
          style={{
            width: "34rem",
            maxWidth: "100%",
            flexShrink: 0,
            // The repo picker carries its own viewport-relative max-height, so a
            // long list scrolls inside itself and the whole step always fits —
            // no flex-height chain, nothing grows the page into a scrollbar.
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          <div
            key={activeStep}
            className="onboarding-shell-step fade-in"
            style={
              needsTeam ? { display: "flex", flexDirection: "column", alignItems: "center", width: "100%" } : undefined
            }
          >
            {needsTeam ? (
              <NoTeamRecovery onCreate={() => setSetupAction("create")} onJoin={() => setSetupAction("join")} />
            ) : (
              <>
                {/* Progress at the top of the column. */}
                <StepProgress />
                {copy.title ? (
                  <h1 className="text-title font-semibold" style={{ margin: "0 0 var(--sp-2_5)", color: "var(--fg)" }}>
                    {copy.title}
                  </h1>
                ) : null}
                {copy.why ? (
                  <p className="text-body" style={{ margin: "0 0 var(--sp-6)", color: "var(--fg-3)" }}>
                    {copy.why}
                  </p>
                ) : null}
                {children}
              </>
            )}
          </div>
        </main>
      </div>
      <TeamSetupModal action={setupAction} onClose={() => setSetupAction(null)} />
      <TeamSwitchOverlay />
    </div>
  );
}

function NoTeamRecovery({ onCreate, onJoin }: { onCreate: () => void; onJoin: () => void }) {
  return (
    <div className="flex w-full max-w-md flex-col items-center text-center">
      <h1 className="text-title font-semibold" style={{ margin: "0 0 var(--sp-2_5)", color: "var(--fg)" }}>
        Create or join a team
      </h1>
      <p className="text-body" style={{ margin: "0 0 var(--sp-6)", color: "var(--fg-3)" }}>
        You need an active team to continue in First Tree.
      </p>
      <div className="grid w-full gap-2 sm:grid-cols-2">
        <Button type="button" onClick={onCreate} className="w-full">
          <Plus className="h-3.5 w-3.5" />
          Create new team
        </Button>
        <Button type="button" variant="outline" onClick={onJoin} className="w-full">
          <UserPlus className="h-3.5 w-3.5" />
          Join with invite link
        </Button>
      </div>
    </div>
  );
}
