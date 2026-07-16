import type { AgentVisibility } from "@first-tree/shared";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { reportOnboardingEvent } from "../../api/onboarding-events.js";
import { useAuth } from "../../auth/auth-context.js";
import {
  type AgentCreationPhase,
  type CreateAgentArgs,
  type CreatedAgentInfo,
  useAgentCreation,
} from "../../features/agent-setup/use-agent-creation.js";
import { type ComputerConnection, useComputerConnection } from "../../features/agent-setup/use-computer-connection.js";
import {
  readOnboardingSelectedRepos,
  writeOnboardingAgentUuid,
  writeOnboardingSelectedRepos,
} from "../../utils/onboarding-flags.js";
import {
  canOfferTeamAgentStart,
  clampStepIndex,
  getStepSequence,
  inferInitialStepIndex,
  type OnboardingPath,
  type ServerOnboardingStep,
  type StepId,
} from "./steps.js";

/**
 * How the tree-setup chat's Context Tree gets set up:
 * - `agentSeed` — DEFAULT for the Context-tab build CTA. No server-side
 *   provisioning; the agent (first-tree-seed) sets the tree up from its actual
 *   state — creating + binding it from zero, or filling a bound-but-empty tree.
 * - `useBoundTree` — the onboarding wizard's bound-tree path (fill/update).
 * - `createBinding` — Cloud one-click provisions the binding first. Retained as
 *   a fallback; no longer the default build path.
 */
export type TreeBindingPlan = "agentSeed" | "useBoundTree" | "createBinding";

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
  /**
   * Whether the invitee `get-started` fork offers the install-free team-agent
   * quick start (`canOfferTeamAgentStart` over the selected membership's
   * readiness bits). Computed here so the step, the shell, tests, and the DEV
   * preview all read one flow-owned fact instead of each consulting auth.
   */
  offerTeamAgentStart: boolean;

  selectedRepoUrls: string[];
  setSelectedRepoUrls: (next: string[]) => void;
  /**
   * True once a per-org repo-selection draft exists (the user has touched the
   * picker, or a saved draft was restored on resume). The connect-code step
   * (retained but not in the live onboarding sequence — see steps.ts) reads
   * this to decide whether to auto-select all granted repos: it only does so
   * when there is NO draft, so a resumed narrowing — to a subset or to none —
   * is never overwritten back to "all".
   */
  hasRepoDraft: boolean;
  treeBindingPlan: TreeBindingPlan;
  setTreeBindingPlan: (next: TreeBindingPlan) => void;
  treeUrl: string;
  setTreeUrl: (next: string) => void;
  /**
   * True once the start-chat step's bound-tree auto-detect has run. Held here
   * (not in a per-mount ref) so leaving start-chat and coming back doesn't re-fire
   * the detect and overwrite the resolved binding plan.
   */
  treeAutoDetectDone: boolean;
  markTreeAutoDetectDone: () => void;

  /** Mark setup finished and drop the user into their first chat. */
  completeAndEnterChat: (chatId: string) => Promise<void>;
  /**
   * Enter the team-agent quick-start chat WITHOUT stamping completion. The
   * kickoff call already wrote the membership's `invitee_skip` suppressor
   * server-side; this only refreshes `/me` (so the workspace gate sees the
   * suppressor instead of bouncing straight back here) and navigates. The
   * member's own connect-computer → create-agent journey stays pending and
   * resumable from Settings → Setup.
   */
  skipAndEnterChat: (chatId: string) => Promise<void>;
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
//
// Scoped by org as well as path: a returning admin can run the admin flow for
// more than one team in the same tab (create team A, then create team B), and
// team A's saved position must not carry into team B and skip it past
// create-agent. A null org (`/me` not resolved yet, so there is no team to
// scope to) disables persistence and falls back to the inferred step — safe
// because the provider mounts only after `/me` loads (see onboarding-page.tsx),
// so anyone actually in the flow already has a resolved org.
const STEP_KEY = (path: OnboardingPath, orgId: string | null): string | null =>
  orgId ? `onboarding:v2:stepIndex:${path}:${orgId}` : null;

function readPersistedStep(path: OnboardingPath, orgId: string | null): number | null {
  if (typeof window === "undefined") return null;
  const key = STEP_KEY(path, orgId);
  if (key === null) return null;
  const raw = window.sessionStorage.getItem(key);
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) ? n : null;
}

function writePersistedStep(path: OnboardingPath, orgId: string | null, index: number): void {
  if (typeof window === "undefined") return;
  const key = STEP_KEY(path, orgId);
  if (key === null) return;
  window.sessionStorage.setItem(key, String(index));
}

function clearPersistedStep(path: OnboardingPath, orgId: string | null): void {
  if (typeof window === "undefined") return;
  const key = STEP_KEY(path, orgId);
  if (key === null) return;
  window.sessionStorage.removeItem(key);
}

/**
 * The step index to land on for `path` within `orgId`: fresh entries start at
 * the opening product step, while a position already persisted for THIS org
 * resumes same-tab progress (for example a redirect round-trip or reload after
 * create-agent). Used on first mount and whenever the selected org changes
 * under a mounted provider.
 */
function resolveLandingStep(path: OnboardingPath, orgStep: ServerOnboardingStep, orgId: string | null): number {
  const inferred = inferInitialStepIndex(path, {
    onboardingStep: orgStep,
    // Kept in the pure API so tests can show server readiness no longer skips
    // the opening step on fresh entry.
    teamSettled: orgStep !== "connect",
  });
  const persisted = readPersistedStep(path, orgId);
  return clampStepIndex(path, persisted === null ? inferred : Math.max(inferred, persisted));
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
    currentOrgHasPersonalAgent,
    currentOrgHasUsableAgent,
    refreshMe,
    dismissOnboarding,
    markOnboardingCompleted,
  } = useAuth();

  // Org-aware step. `onboardingStep` from /me is account-level: its
  // `create_agent` / `completed` value reflects whether the user has set up
  // an agent in *any* org. For step selection we care about the *current*
  // org, so once past the account-level `connect` stage we recompute
  // create_agent vs completed from this membership's personal-agent readiness
  // — otherwise a returning user joining a team with only another member's
  // shared agent would skip straight to start-chat without their own agent.
  const orgStep: ServerOnboardingStep =
    onboardingStep === "connect" || onboardingStep === null
      ? onboardingStep
      : currentOrgHasPersonalAgent
        ? "completed"
        : "create_agent";

  const sequence = getStepSequence(path);
  const [activeIndex, setActiveIndex] = useState<number>(() => resolveLandingStep(path, orgStep, organizationId));

  // The onboarding shell renders the real TeamSwitcher for multi-team users, so the
  // selected org can change while this provider stays mounted (creating /
  // joining / switching teams calls selectOrganization without a route
  // remount). Re-derive the landing step for the new org rather than carry the
  // previous team's activeIndex — otherwise the write effect below would
  // persist it under the new org's key and skip the new team past create-agent.
  // Adjusting state during render (guarded by the org check) is React's
  // recommended way to reset derived state on a prop change; it runs before the
  // write effect, so the stale index is never committed to the new org's key.
  const [stepOrg, setStepOrg] = useState(organizationId);
  if (organizationId !== stepOrg) {
    setStepOrg(organizationId);
    setActiveIndex(resolveLandingStep(path, orgStep, organizationId));
  }

  useEffect(() => {
    writePersistedStep(path, organizationId, activeIndex);
  }, [path, organizationId, activeIndex]);

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
  const onAgentCreated = useCallback((info: CreatedAgentInfo) => {
    writeOnboardingAgentUuid(info.agentUuid);
    void reportOnboardingEvent("agent_created", { runtimeProvider: info.args.runtimeProvider });
  }, []);
  const {
    phase: agentPhase,
    error: agentError,
    create: createAgent,
    retry: retryAgent,
    createdUuid: createdAgentUuid,
  } = useAgentCreation({ onCreated: onAgentCreated, onOnline: onAgentOnline });

  const [agentDisplayName, setAgentDisplayName] = useState<string>(() =>
    user?.username ? `${user.username} assistant` : "Assistant",
  );
  const [visibility, setVisibility] = useState<AgentVisibility>("organization");
  // Hydrate the repo selection from this org's saved draft so a bailout before
  // start-chat (top-bar "finish later", a refresh, a mid-flow navigation) resumes
  // with the picked repos instead of losing them. `null` draft → empty (the
  // connect-code step — retained but not in the live sequence, see steps.ts —
  // would auto-select all granted repos); a non-null draft — including `[]` —
  // is a deliberate selection we restore verbatim.
  const [selectedRepoUrls, setSelectedRepoUrlsState] = useState<string[]>(() =>
    organizationId ? (readOnboardingSelectedRepos(organizationId) ?? []) : [],
  );
  const [hasRepoDraft, setHasRepoDraft] = useState<boolean>(() =>
    organizationId ? readOnboardingSelectedRepos(organizationId) !== null : false,
  );
  // Which org's draft is loaded into state. A late-arriving organizationId (the
  // `/me` round-trip resolves after first paint) or an org switch hydrates that
  // org's draft exactly once — not on every render, so an in-progress edit is
  // never clobbered back to the stored value.
  const hydratedDraftOrgRef = useRef<string | null>(organizationId);
  useEffect(() => {
    if (!organizationId || hydratedDraftOrgRef.current === organizationId) return;
    hydratedDraftOrgRef.current = organizationId;
    const draft = readOnboardingSelectedRepos(organizationId);
    setHasRepoDraft(draft !== null);
    setSelectedRepoUrlsState(draft ?? []);
  }, [organizationId]);

  // Wrap the setter so every change writes through to the per-org draft and
  // marks a draft as present. The formal team-resource write still happens only
  // at start-chat — this is the in-flight draft that survives a bailout.
  const setSelectedRepoUrls = useCallback(
    (next: string[]) => {
      setSelectedRepoUrlsState(next);
      setHasRepoDraft(true);
      if (organizationId) writeOnboardingSelectedRepos(organizationId, next);
    },
    [organizationId],
  );
  const [treeBindingPlan, setTreeBindingPlan] = useState<TreeBindingPlan>("createBinding");
  const [treeUrl, setTreeUrl] = useState<string>("");
  const [treeAutoDetectDone, setTreeAutoDetectDone] = useState(false);
  const markTreeAutoDetectDone = useCallback(() => setTreeAutoDetectDone(true), []);

  const completeAndEnterChat = useCallback(
    async (chatId: string) => {
      // Single-chat start-chat paths may already have stamped completion inside
      // POST /me/onboarding/kickoff. Support/background paths deliberately defer
      // that stamp until every required side effect succeeds, then call this
      // helper. The write stays idempotent and best-effort so a network blip
      // does not strand the user after the required chat exists.
      //
      // Deliberately NOT `dismissOnboarding()`: completion writes a
      // membership-scoped suppress stamp with reason="completed". Reusing the
      // finish-later path here would blur the reason semantics that keep new
      // memberships eligible for first-need onboarding.
      clearPersistedStep(path, organizationId);
      // Clear the per-tab agent-uuid stash now that start-chat has resolved and
      // used it — so a later same-tab onboarding/recovery in a DIFFERENT org
      // can't read a stale cross-org agent (the org filter in
      // resolveOnboardingAgent only catches that when the org id is known).
      writeOnboardingAgentUuid(null);
      // The selection has now been consumed by start-chat (written as team repo
      // resources), so drop the in-flight draft — a later same-tab onboarding
      // in this org starts clean rather than resurrecting a stale pick. Only
      // completion clears it; `finishLater` deliberately keeps it so the user
      // resumes their selection.
      if (organizationId) writeOnboardingSelectedRepos(organizationId, null);
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
    [path, organizationId, markOnboardingCompleted, navigate],
  );

  const skipAndEnterChat = useCallback(
    async (chatId: string) => {
      clearPersistedStep(path, organizationId);
      // Same per-tab hygiene as completion: the stash was never consumed on
      // this path (the quick-start chat uses a teammate's agent), but clearing
      // it keeps a later same-tab onboarding in another org from reading a
      // stale value.
      writeOnboardingAgentUuid(null);
      // The kickoff already stamped `invitee_skip` server-side. Refresh /me so
      // the auth context carries the suppressor BEFORE navigating — the
      // workspace gate reads it, and navigating with stale state would bounce
      // the user straight back into onboarding.
      await refreshMe();
      navigate(`/?c=${encodeURIComponent(chatId)}`);
    },
    [path, organizationId, refreshMe, navigate],
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
      offerTeamAgentStart: canOfferTeamAgentStart({ currentOrgHasUsableAgent, currentOrgHasPersonalAgent }),
      selectedRepoUrls,
      setSelectedRepoUrls,
      hasRepoDraft,
      treeBindingPlan,
      setTreeBindingPlan,
      treeUrl,
      setTreeUrl,
      treeAutoDetectDone,
      markTreeAutoDetectDone,
      completeAndEnterChat,
      skipAndEnterChat,
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
      currentOrgHasUsableAgent,
      currentOrgHasPersonalAgent,
      selectedRepoUrls,
      setSelectedRepoUrls,
      hasRepoDraft,
      treeBindingPlan,
      treeUrl,
      treeAutoDetectDone,
      markTreeAutoDetectDone,
      completeAndEnterChat,
      skipAndEnterChat,
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
