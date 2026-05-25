import type { AgentVisibility } from "@first-tree/shared";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../../auth/auth-context.js";
import { clampStepIndex, getStepSequence, inferInitialStepIndex, type OnboardingPath, type StepId } from "./steps.js";
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
   * True once the user has an AI teammate (server reports `completed`, or one
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

  /** Mark setup finished and drop the user into their first chat. */
  completeAndEnterChat: (chatId: string) => Promise<void>;
  /** Hide setup and go to the normal workspace (resumable via Settings). */
  finishLater: () => Promise<void>;
};

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
    refreshMe,
    dismissOnboarding,
    markOnboardingCompleted,
  } = useAuth();

  const sequence = getStepSequence(path);
  const [activeIndex, setActiveIndex] = useState<number>(() => {
    const inferred = inferInitialStepIndex(path, {
      onboardingStep,
      // We can't observe finer team-rename state synchronously; the team
      // step is cheap to revisit, so default returning admins past it only
      // when the server already proves a computer exists.
      teamSettled: onboardingStep !== "connect",
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

  const completeAndEnterChat = useCallback(
    async (chatId: string) => {
      // Hide the inline workspace stepper AND stamp the terminal flag, then
      // land in the freshly-created chat. Both writes are idempotent and
      // already flip optimistic client state, so run them in parallel and
      // never let a transient failure strand the user — always navigate.
      clearPersistedStep(path);
      await Promise.allSettled([dismissOnboarding(), markOnboardingCompleted()]);
      navigate(`/?c=${encodeURIComponent(chatId)}`);
    },
    [path, dismissOnboarding, markOnboardingCompleted, navigate],
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
      hasAgent: onboardingStep === "completed" || createdAgentUuid !== null,
      selectedRepoUrls,
      setSelectedRepoUrls,
      treeMode,
      setTreeMode,
      treeUrl,
      setTreeUrl,
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
      onboardingStep,
      selectedRepoUrls,
      treeMode,
      treeUrl,
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
