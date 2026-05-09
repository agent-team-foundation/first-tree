import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useAuth } from "../../../auth/auth-context.js";
import { useToast } from "../../../components/ui/toast.js";
import { readStep1Confirmed } from "../../../utils/onboarding-flags.js";

/**
 * OnboardingStepper — the 3-step progress indicator that lives above
 * `CenterPanel` (above CenterPanel only — does NOT span the rail). See
 * docs/new-user-onboarding-design.md §4.1 / §4.6.
 *
 * Visibility is decoupled from `onboardingStep` and tied to
 * `onboardingDismissedAt` (§8): the stepper renders iff the user has not
 * clicked `✕`. Active step is derived client-side from
 * `onboardingStep + URL.?c=<chatId>`:
 *
 *   - URL has ?c=<chatId>          → UI Step 3 active (chat in flight)
 *   - onboardingStep "connect"     → UI Step 2 (Step 1 has no server state)
 *   - onboardingStep "create_agent"→ UI Step 2
 *   - onboardingStep "completed"   → UI Step 3 (intro card)
 *
 * UI Step 1's "active" state is driven by an explicit URL marker
 * (`?step=team`) so the user can revisit Step 1 after Steps 2/3 — the
 * server view of "connect" can't disambiguate "haven't started Step 1"
 * from "Step 1 done, awaiting client connect".
 */

type StepIndex = 1 | 2 | 3;
type CircleState = "pending" | "active" | "completed" | "error";

const STEP_LABELS: Record<StepIndex, string> = {
  1: "Name your team",
  2: "Set up your agent",
  3: "Build your context-tree",
};

export function OnboardingStepper() {
  const { onboardingStep, onboardingDismissedAt, dismissOnboarding } = useAuth();
  const { addToast } = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedChatId = searchParams.get("c");
  const stepOverride = searchParams.get("step");

  // Read the per-tab Step 1 acknowledgement flag every render. The flag is
  // written by `OnboardingView`'s Step1Body Continue handler, but the
  // stepper has no React subscription to that storage event — re-reading on
  // each render is cheap (sessionStorage.getItem is sync) and keeps the
  // stepper visuals consistent with whichever body the view chose to show.
  const step1Confirmed = readStep1Confirmed();

  const activeStep = useMemo<StepIndex>(() => {
    if (stepOverride === "team") return 1;
    if (stepOverride === "agent") return 2;
    if (stepOverride === "tree") return 3;
    if (selectedChatId) return 3;
    if (onboardingStep === "completed") return 3;
    if (onboardingStep === "create_agent") return 2;
    // onboardingStep === "connect": team auto-created at OAuth but the
    // user may not have confirmed Step 1 yet. Honor the per-tab flag so
    // the stepper Active circle matches the body actually rendering.
    if (onboardingStep === "connect" && !step1Confirmed) return 1;
    return 2;
  }, [stepOverride, selectedChatId, onboardingStep, step1Confirmed]);

  // A user with no auth is irrelevant here — onboardingStep null implies
  // the /me round-trip hasn't landed yet; render nothing rather than a
  // half-state stepper that flashes labels in.
  if (onboardingStep === null) return null;
  if (onboardingDismissedAt) return null;

  // Dismiss is gated on Step 2 being done — i.e., the user has both a
  // connected client and at least one non-human agent. Letting users hide
  // the stepper before that lands them on an empty workspace with no
  // guidance for "what now?". Once Step 2 completes the workspace is
  // functional, so dismissing is a legitimate "I'll skip Step 3" choice.
  const canDismiss = onboardingStep === "completed";

  const handleDismiss = () => {
    void dismissOnboarding();
    addToast({
      title: "Setup hidden",
      description: "Resume any time in Settings → Setup.",
      action: { label: "Open settings", onClick: () => navigate("/settings/setup") },
    });
  };

  const stepStates: Record<StepIndex, CircleState> = {
    1: stateFor(1, activeStep, onboardingStep),
    2: stateFor(2, activeStep, onboardingStep),
    3: stateFor(3, activeStep, onboardingStep),
  };

  const handleStepClick = (s: StepIndex) => {
    // Only Step 3 routes through here (callers gate onClick to that single
    // case). Drop any `?c=` so CenterPanel falls through to OnboardingView
    // (ChatByIdView would otherwise mask the Step 3 body), then set
    // `?step=tree` which makes OnboardingView clear `step3IntroDismissed`
    // and render the IntroBody.
    if (s !== 3) return;
    const next = new URLSearchParams(searchParams);
    next.delete("c");
    next.set("step", "tree");
    setSearchParams(next, { replace: false });
  };

  return (
    <nav
      aria-label="Onboarding progress"
      className="flex items-center"
      style={{
        gap: "var(--sp-3)",
        padding: "var(--sp-3) var(--sp-4)",
        borderBottom: "var(--hairline) solid var(--border)",
        background: "var(--bg)",
      }}
    >
      <ol
        className="flex items-center justify-center flex-1 min-w-0"
        style={{ gap: 0, listStyle: "none", margin: 0, padding: 0 }}
      >
        {([1, 2, 3] as StepIndex[]).map((s, idx) => {
          const state = stepStates[s];
          const next = ([1, 2, 3] as StepIndex[])[idx + 1];
          const lineSolid = next ? isAchieved(state) && isAchieved(stepStates[next]) : false;
          return (
            <li key={s} className="flex items-center" style={{ minWidth: 0 }}>
              <StepCircle
                index={s}
                state={state}
                label={STEP_LABELS[s]}
                // Completed pips are progress indicators, not navigation —
                // edits to team / agent live in Settings, and revisiting an
                // onboarding form for a completed step creates state
                // conflicts (e.g., re-clicking Step 2's Create button).
                // Only Step 3's active pip stays clickable: Step 3 has no
                // terminal server-tracked completion, and clicking it from
                // any chat (including a manual one that masks OnboardingView)
                // is the only way back to the IntroBody.
                onClick={s === 3 && state === "active" ? () => handleStepClick(s) : undefined}
              />
              {next ? <ConnectionLine solid={lineSolid} /> : null}
            </li>
          );
        })}
      </ol>

      <button
        type="button"
        onClick={handleDismiss}
        disabled={!canDismiss}
        title={canDismiss ? "Hide setup steps" : "Finish setting up your agent first"}
        aria-label="Hide setup steps"
        className={canDismiss ? "cursor-pointer" : "cursor-not-allowed"}
        style={{
          flexShrink: 0,
          width: 24,
          height: 24,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          background: "transparent",
          border: 0,
          borderRadius: "var(--rd-1)",
          color: canDismiss ? "var(--fg-2)" : "var(--fg-4)",
          fontSize: 14,
          lineHeight: 1,
          opacity: canDismiss ? 1 : 0.5,
        }}
        onMouseEnter={(e) => {
          if (canDismiss) e.currentTarget.style.background = "var(--surface-2)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
        }}
      >
        ✕
      </button>
    </nav>
  );
}

function stateFor(
  index: StepIndex,
  active: StepIndex,
  serverStep: "connect" | "create_agent" | "completed" | null,
): CircleState {
  if (index === active) return "active";
  if (index === 1) {
    // Step 1 (team) is "completed" the moment the user lands on the
    // workspace — `completeOauthFlow` always pre-creates the team. There
    // is no "team-creation in progress" state on the server.
    return "completed";
  }
  if (index === 2) {
    // Step 2 is "completed" iff the server says onboarding is past it.
    // Anything earlier is "pending" (when active === 1, the user hasn't
    // started Step 2 yet).
    if (serverStep === "completed") return "completed";
    return "pending";
  }
  // index === 3
  return "pending";
}

function isAchieved(s: CircleState): boolean {
  return s === "active" || s === "completed";
}

function StepCircle({
  index,
  state,
  label,
  onClick,
}: {
  index: StepIndex;
  state: CircleState;
  label: string;
  onClick?: () => void;
}) {
  // Clickability is decided by the caller (which passes `onClick` only when
  // the click would have an effect). Letting `onClick` presence drive
  // cursor/disabled here means active-state Step 3 can be clicked to
  // re-open the IntroBody from placeholder, while pending pips stay inert.
  const clickable = !!onClick;
  const circle = renderCircle(state, index);
  return (
    <button
      type="button"
      onClick={clickable ? onClick : undefined}
      disabled={!clickable}
      aria-current={state === "active" ? "step" : undefined}
      className={`flex items-center ${clickable ? "cursor-pointer" : "cursor-default"}`}
      style={{
        gap: "var(--sp-2)",
        background: "transparent",
        border: 0,
        padding: 0,
        font: "inherit",
        color: state === "active" ? "var(--fg)" : state === "completed" ? "var(--fg-2)" : "var(--fg-3)",
        fontWeight: state === "active" ? 600 : 500,
      }}
    >
      {circle}
      <span
        className="text-label whitespace-nowrap"
        style={{
          textDecoration: clickable ? "none" : undefined,
        }}
      >
        Step {index} · {label}
      </span>
    </button>
  );
}

function renderCircle(state: CircleState, index: StepIndex) {
  const baseSize = 22;
  if (state === "completed") {
    return (
      <span
        aria-hidden="true"
        style={{
          width: baseSize,
          height: baseSize,
          borderRadius: "50%",
          background: "var(--accent)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: "white",
          fontSize: 12,
          lineHeight: 1,
          flexShrink: 0,
        }}
      >
        ✓
      </span>
    );
  }
  if (state === "active") {
    return (
      <span
        aria-hidden="true"
        style={{ position: "relative", width: baseSize, height: baseSize, flexShrink: 0, display: "inline-block" }}
      >
        {/* Outer ripple — same `ring-pulse` keyframe used by PulsingDot
            and DisconnectChip elsewhere in the app, kept subtle (hairline
            accent border, 0.5 base opacity) so it doesn't out-compete
            body content. */}
        <span
          style={{
            position: "absolute",
            inset: -3,
            borderRadius: "50%",
            border: "var(--hairline) solid var(--accent)",
            animation: "ring-pulse 1.8s infinite",
            opacity: 0.5,
          }}
        />
        {/* Solid filled circle with the step number */}
        <span
          className="mono"
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "50%",
            background: "var(--accent)",
            border: "var(--hairline-bold) solid var(--accent)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: "white",
            fontSize: 12,
            fontWeight: 600,
            lineHeight: 1,
          }}
        >
          {index}
        </span>
      </span>
    );
  }
  if (state === "error") {
    return (
      <span
        aria-hidden="true"
        style={{
          width: baseSize,
          height: baseSize,
          borderRadius: "50%",
          background: "var(--state-error)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: "white",
          fontSize: 13,
          lineHeight: 1,
          flexShrink: 0,
        }}
      >
        ⊗
      </span>
    );
  }
  // pending
  return (
    <span
      aria-hidden="true"
      style={{
        width: baseSize,
        height: baseSize,
        borderRadius: "50%",
        background: "transparent",
        border: "var(--hairline) solid var(--fg-3)",
        flexShrink: 0,
        display: "inline-block",
      }}
    />
  );
}

function ConnectionLine({ solid }: { solid: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        flex: "0 1 var(--sp-15)",
        minWidth: 24,
        height: 0,
        margin: "0 var(--sp-2)",
        borderTop: solid ? "var(--hairline-bold) solid var(--accent)" : "var(--hairline) dashed var(--fg-3)",
      }}
    />
  );
}
