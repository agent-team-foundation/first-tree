import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { useAuth } from "../../../auth/auth-context.js";
import { readStep1Confirmed, writeOnboardingReturnChatId } from "../../../utils/onboarding-flags.js";

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
  1: "Create team",
  2: "Connect agent",
  3: "Init context-tree",
};

export function OnboardingStepper() {
  const { onboardingStep, onboardingDismissedAt, dismissOnboarding, role } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedChatId = searchParams.get("c");
  const stepOverride = searchParams.get("step");

  // Step 1 is admin-only — its Continue handler PATCHes /orgs/:id which
  // requires `requireOrgAdmin` server-side. For non-admin members the pip
  // is rendered but disabled (visual-only completion mark).
  const canRenameTeam = role === "admin";

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

  const stepStates: Record<StepIndex, CircleState> = {
    1: stateFor(1, activeStep, onboardingStep),
    2: stateFor(2, activeStep, onboardingStep),
    3: stateFor(3, activeStep, onboardingStep),
  };

  const handleStepClick = (s: StepIndex) => {
    if (stepStates[s] === "pending") return;
    if (s === activeStep) return;
    // Step 1 is admin-only (PATCH /orgs/:id is requireOrgAdmin server-side).
    // Members see the completed pip as a no-op rather than a 403 surprise.
    if (s === 1 && !canRenameTeam) return;
    const next = new URLSearchParams(searchParams);
    // CenterPanel routes ChatByIdView before OnboardingView, so the chat
    // URL has to come off when the user revisits Steps 1 / 2 — otherwise
    // the form never renders. Stash the chat id so Step 1 / 2 Continue
    // can restore it instead of stranding the user on `/`.
    if (s === 1) {
      if (selectedChatId) writeOnboardingReturnChatId(selectedChatId);
      next.delete("c");
      next.set("step", "team");
    } else if (s === 2) {
      if (selectedChatId) writeOnboardingReturnChatId(selectedChatId);
      next.delete("c");
      next.set("step", "agent");
    } else {
      // Step 3 is the chat home — clear any stash so we don't bounce back
      // through it later.
      writeOnboardingReturnChatId(null);
      next.set("step", "tree");
    }
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
      <ol className="flex items-center flex-1 min-w-0" style={{ gap: 0, listStyle: "none", margin: 0, padding: 0 }}>
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
                onClick={state === "completed" ? () => handleStepClick(s) : undefined}
              />
              {next ? <ConnectionLine solid={lineSolid} /> : null}
            </li>
          );
        })}
      </ol>

      <button
        type="button"
        onClick={() => void dismissOnboarding()}
        title="Hide setup steps"
        aria-label="Hide setup steps"
        className="cursor-pointer"
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
          color: "var(--fg-2)",
          fontSize: 14,
          lineHeight: 1,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--surface-2)";
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
  const clickable = state === "completed" && !!onClick;
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
        className="mono"
        style={{
          width: baseSize,
          height: baseSize,
          borderRadius: "50%",
          background: "var(--accent)",
          border: "var(--hairline-bold) solid var(--accent)",
          boxShadow: "0 0 0 var(--sp-1) var(--accent-ring)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: "white",
          fontSize: 12,
          fontWeight: 600,
          lineHeight: 1,
          flexShrink: 0,
        }}
      >
        {index}
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
