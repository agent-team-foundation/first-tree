import type { AgentVisibility } from "@first-tree/shared";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../../auth/auth-context.js";
import { writeOnboardingAgentUuid } from "../../utils/onboarding-flags.js";
import {
  clampStepIndex,
  getStepSequence,
  inferInitialStepIndex,
  type OnboardingPath,
  type ServerOnboardingStep,
  type StepId,
} from "./steps.js";
import { type AgentCreationPhase, type CreateAgentArgs, useAgentCreation } from "./use-agent-creation.js";
import { type ComputerConnection, useComputerConnection } from "./use-computer-connection.js";

export type TreeMode = "new" | "existing";

export type OnboardingFlowValue = {
  path: OnboardingPath;
  sequence: readonly StepId[];
  activeIndex: number;
  activeStep: StepId;
  goNext: () => void;
  goTo: (index: number) => void;

  organizationId: string | null;
  memberId: string | null;
  role: string | null;
  username: string | null;
  teamDisplayName: string | null;
  orgHasOtherMembers: boolean;

  computer: ComputerConnection;

  agentDisplayName: string;
  setAgentDisplayName: (next: string) => void;
  visibility: AgentVisibility;
  setVisibility: (next: AgentVisibility) => void;
  agentPhase: AgentCreationPhase;
  agentError: string | null;
  createAgent: (args: CreateAgentArgs) => Promise<void>;
  retryAgent: () => Promise<void>;
  createdAgentUuid: string | null;
  /**
   * True once the user has an agent (server reports `completed`, or one
   * was just created this session). Gates whether leaving to the workspace is
   * useful — before this there's nothing there, so the flow withholds the
   * "I'll finish later" escape.
   */
  hasAgent: boolean;

  selectedRepoUrls: string[];
  setSelectedRepoUrls: (next: string[]) => void;
  treeMode: TreeMode;
  setTreeMode: (next: TreeMode) => void;
  treeUrl: string;
  setTreeUrl: (next: string) => void;
  /**
   * True once the kickoff step's existing-tree auto-detect has run. Held here
   * (not in a per-mount ref) so leaving kickoff and coming back doesn't re-fire
   * the detect and overwrite the user's explicit "Create new instead" choice.
   */
  treeAutoInitDone: boolean;
  markTreeAutoInitDone: () => void;

  /** Mark setup finished and drop the user into their first chat. */
  completeAndEnterChat: (chatId: string) => Promise<void>;
  /** Hide setup and go to the normal workspace (resumable via Settings). */
  finishLater: () => Promise<void>;
};

// Exported so the DEV-only onboarding preview page (pages/onboarding-preview.tsx)
// can inject fixture flow values and render the real step components without the
// live provider's API-backed hooks. Production code uses OnboardingFlowProvider /
// useOnboardingFlow below and never touches the raw context.
export const OnboardingFlowContext = createContext<OnboardingFlowValue | null>(null);

// Remember the active step for the tab's lifetime so a full-page round-trip
// (notably the GitHub App install redirect to github.com and back) returns
// the user exactly where they were instead of resetting to step 1.
const STEP_KEY = (path: OnboardingPath) => `onboarding:stepIndex:${path}`;

function readPersistedStep(path: OnboardingPath): number | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(STEP_KEY(path));
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) ? n : null;
}

function writePersistedStep(path: OnboardingPath, index: number): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(STEP_KEY(path), String(index));
}

function clearPersistedStep(path: OnboardingPath): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(STEP_KEY(path));
}

export function OnboardingFlowProvider({ path, children }: { path: OnboardingPath; children: ReactNode }) {
  const navigate = useNavigate();
  const {
    organizationId,
    memberId,
    role,
    user,
    teamDisplayName,
    orgHasOtherMembers,
    onboardingStep,
    currentOrgHasUsableAgent,
    refreshMe,
    dismissOnboarding,
    markOnboardingCompleted,
  } = useAuth();

  // Org-aware step. `onboardingStep` from /me is account-level: its
  // `create_agent` / `completed` value reflects whether the user has set up
  // an agent in *any* org. For step selection we care about the *current*
  // org, so once past the account-level `connect` stage we recompute
  // create_agent vs completed from this org's readiness — otherwise a
  // returning user joining an empty org would skip straight to kickoff.
  const orgStep: ServerOnboardingStep =
    onboardingStep === "connect" || onboardingStep === null
      ? onboardingStep
      : currentOrgHasUsableAgent
        ? "completed"
        : "create_agent";

  const sequence = getStepSequence(path);
  const [activeIndex, setActiveIndex] = useState<number>(() => {
    const inferred = inferInitialStepIndex(path, {
      onboardingStep: orgStep,
      // We can't observe finer team-rename state synchronously; the team
      // step is cheap to revisit, so default returning admins past it only
      // when the server already proves a computer exists.
      teamSettled: orgStep !== "connect",
    });
    // Resume a persisted position, but never drop *behind* what the server
    // can prove (so a stale marker can't strand a user before their real
    // progress).
    const persisted = readPersistedStep(path);
    return clampStepIndex(path, persisted === null ? inferred : Math.max(inferred, persisted));
  });

  useEffect(() => {
    writePersistedStep(path, activeIndex);
  }, [path, activeIndex]);

  const goTo = useCallback((index: number) => setActiveIndex(clampStepIndex(path, index)), [path]);
  const goNext = useCallback(() => setActiveIndex((i) => clampStepIndex(path, i + 1)), [path]);

  const activeStep = sequence[clampStepIndex(path, activeIndex)] as StepId;

  // The computer poll only needs to run on the two steps that depend on it.
  const computerEnabled = activeStep === "connect-computer" || activeStep === "create-agent";
  const computer = useComputerConnection(computerEnabled);

  const onAgentOnline = useCallback(() => {
    void refreshMe();
    setActiveIndex((i) => clampStepIndex(path, i + 1));
  }, [refreshMe, path]);
  const {
    phase: agentPhase,
    error: agentError,
    create: createAgent,
    retry: retryAgent,
    createdUuid: createdAgentUuid,
  } = useAgentCreation(onAgentOnline);

  const [agentDisplayName, setAgentDisplayName] = useState<string>(() =>
    user?.username ? `${user.username}'s assistant` : "Assistant",
  );
  const [visibility, setVisibility] = useState<AgentVisibility>("organization");
  const [selectedRepoUrls, setSelectedRepoUrls] = useState<string[]>([]);
  const [treeMode, setTreeMode] = useState<TreeMode>("new");
  const [treeUrl, setTreeUrl] = useState<string>("");
  const [treeAutoInitDone, setTreeAutoInitDone] = useState(false);
  const markTreeAutoInitDone = useCallback(() => setTreeAutoInitDone(true), []);

  const completeAndEnterChat = useCallback(
    async (chatId: string) => {
      // Stamp the terminal flag, then land in the freshly-created chat. The
      // write is idempotent and already flips optimistic client state, so
      // never let a transient failure strand the user — always navigate.
      //
      // Deliberately NOT `dismissOnboarding()`: dismissal is the account-level
      // "finish later" suppressor, and `shouldEnterOnboarding` consults it
      // before the org-level readiness check. Stamping it on the normal finish
      // path made the per-org re-entry gate unreachable for anyone who ever
      // completed onboarding — joining a second/empty org landed them in a
      // bare workspace with no way back (the original call's target, the
      // retired inline workspace stepper, no longer exists).
      clearPersistedStep(path);
      // Clear the per-tab agent-uuid stash now that the kickoff has resolved and
      // used it — so a later same-tab onboarding/recovery in a DIFFERENT org
      // can't read a stale cross-org agent (the org filter in
      // resolveOnboardingAgent only catches that when the org id is known).
      writeOnboardingAgentUuid(null);
      try {
        await markOnboardingCompleted();
      } catch {
        // Intentionally swallowed: the completion stamp is best-effort at
        // this point. The API helper already catches its own failures, but
        // keep the always-navigate invariant local to this flow rather than
        // depending on a callee's error handling.
      }
      navigate(`/?c=${encodeURIComponent(chatId)}`);
    },
    [path, markOnboardingCompleted, navigate],
  );

  const finishLater = useCallback(async () => {
    await dismissOnboarding();
    navigate("/");
  }, [dismissOnboarding, navigate]);

  const value = useMemo<OnboardingFlowValue>(
    () => ({
      path,
      sequence,
      activeIndex,
      activeStep,
      goNext,
      goTo,
      organizationId,
      memberId,
      role,
      username: user?.username ?? null,
      teamDisplayName,
      orgHasOtherMembers,
      computer,
      agentDisplayName,
      setAgentDisplayName,
      visibility,
      setVisibility,
      agentPhase,
      agentError,
      createAgent,
      retryAgent,
      createdAgentUuid,
      hasAgent: orgStep === "completed" || createdAgentUuid !== null,
      selectedRepoUrls,
      setSelectedRepoUrls,
      treeMode,
      setTreeMode,
      treeUrl,
      setTreeUrl,
      treeAutoInitDone,
      markTreeAutoInitDone,
      completeAndEnterChat,
      finishLater,
    }),
    [
      path,
      sequence,
      activeIndex,
      activeStep,
      goNext,
      goTo,
      organizationId,
      memberId,
      role,
      user?.username,
      teamDisplayName,
      orgHasOtherMembers,
      computer,
      agentDisplayName,
      visibility,
      agentPhase,
      agentError,
      createAgent,
      retryAgent,
      createdAgentUuid,
      orgStep,
      selectedRepoUrls,
      treeMode,
      treeUrl,
      treeAutoInitDone,
      markTreeAutoInitDone,
      completeAndEnterChat,
      finishLater,
    ],
  );

  return <OnboardingFlowContext.Provider value={value}>{children}</OnboardingFlowContext.Provider>;
}

export function useOnboardingFlow(): OnboardingFlowValue {
  const ctx = useContext(OnboardingFlowContext);
  if (!ctx) throw new Error("useOnboardingFlow must be used within OnboardingFlowProvider");
  return ctx;
}
