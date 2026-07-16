import { ArrowRight } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { getNewChatDefaultCandidates } from "../../api/agents.js";
import { startLandingCampaign } from "../../api/landing-campaigns.js";
import { createMeTaskChat } from "../../api/me-chats.js";
import { useAuth } from "../../auth/auth-context.js";
import { Button } from "../../components/ui/button.js";
import { useGrowthLandingPagesState } from "../../hooks/use-server-channel.js";
import { writeCampaignActionHandoffFlag } from "../../utils/onboarding-flags.js";
import { FlowHint, StatusRow, WorkingState } from "../onboarding/flow-ui.js";
import { shouldLeaveOnboarding } from "../onboarding/steps.js";
import { buildCampaignActionBootstrap } from "../workspace/center/onboarding/bootstrap-prose.js";
import { WorkspaceBody } from "../workspace/index.js";
import { getCampaign } from "./campaigns.js";
import {
  type CampaignIntent,
  clearCampaignIntent,
  hasCampaignHandoff,
  readCampaignActionHandoff,
  readCampaignHandoff,
  readCampaignIntent,
  writeCampaignIntent,
} from "./intent.js";

/**
 * Reusable landing campaign handoff (`/quickstart?campaign=<slug>&repo=...`).
 *
 * The public landing page owns the CTA and repo collection. Quickstart owns the
 * post-login recovery and then asks the server to create the official
 * service-managed trial agent + single-run chat. It intentionally no longer
 * waits for a local computer or creates the user's Cedar agent.
 */
export function QuickstartPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    organizationId,
    refreshMe,
    meLoaded,
    onboardingStep,
    onboardingDismissedAt,
    onboardingCompletedAt,
    currentOrgHasPersonalAgent,
  } = useAuth();
  const { enabled: growthLandingPagesEnabled, settled } = useGrowthLandingPagesState();
  // The trial chat is selected with the normal workspace `?c=` param so
  // `WorkspaceBody` picks it up unchanged — no bespoke `?chat=` handoff.
  const chatId = useMemo(() => new URLSearchParams(location.search).get("c"), [location.search]);
  // Back-compat: trials minted before this migration used `?chat=<id>`.
  // Canonicalize such a legacy URL to `?c=` (effect below) so an already-open
  // trial tab, bookmark, copied link, or reload still opens the trial chat
  // instead of silently falling through to the no-chat state.
  const legacyChatId = useMemo(() => new URLSearchParams(location.search).get("chat"), [location.search]);

  // A configured action is not a trial launch: store the handoff and
  // send the user to normal onboarding (their own agent does the fixing). The
  // trial-intent memo below must never see these params — readCampaignHandoff
  // skips action=fix, and this memo short-circuits it too.
  const actionHandoff = useMemo(() => {
    if (chatId || legacyChatId) return null;
    return readCampaignActionHandoff(location);
  }, [chatId, legacyChatId, location]);

  const intent = useMemo<CampaignIntent | null>(() => {
    if (actionHandoff) return null;
    // A selected chat — `?c=` OR a legacy `?chat=` about to be canonicalized —
    // means "open this chat", not "launch a trial". Short-circuit both so a
    // stored campaign intent in sessionStorage can't hijack a legacy link into
    // starting a fresh trial before the redirect lands.
    if (chatId || legacyChatId) return null;
    const fromUrl = readCampaignHandoff(location);
    if (fromUrl) {
      writeCampaignIntent(fromUrl);
      return fromUrl;
    }
    if (hasCampaignHandoff(location)) {
      clearCampaignIntent();
      return null;
    }
    return readCampaignIntent();
  }, [actionHandoff, chatId, legacyChatId, location]);
  const campaign = intent ? getCampaign(intent.campaign) : null;
  const actionCampaign = actionHandoff ? getCampaign(actionHandoff.campaign) : null;

  const startStartedRef = useRef(false);
  const [startError, setStartError] = useState<string | null>(null);

  const startTrial = useCallback(async () => {
    // `legacyChatId` guards alongside `chatId`: a legacy `?chat=` link is a
    // selected chat being canonicalized, never a launch trigger — even if a
    // stale campaign intent lingers in sessionStorage. `actionHandoff` guards too
    // so a fix link can never start a trial even transiently.
    if (
      chatId ||
      legacyChatId ||
      actionHandoff ||
      !intent ||
      !campaign ||
      startStartedRef.current ||
      !growthLandingPagesEnabled
    )
      return;
    startStartedRef.current = true;
    setStartError(null);
    try {
      const { chatId: trialChatId } = await startLandingCampaign({
        ...(organizationId ? { organizationId } : {}),
        campaign: intent.campaign,
        repoUrl: intent.url,
      });
      clearCampaignIntent();
      await refreshMe();
      navigate(`/quickstart?c=${encodeURIComponent(trialChatId)}`, { replace: true });
    } catch (err) {
      startStartedRef.current = false;
      setStartError(err instanceof Error ? err.message : "Couldn't open your trial chat. Please try again.");
    }
  }, [
    chatId,
    legacyChatId,
    actionHandoff,
    intent,
    campaign,
    organizationId,
    growthLandingPagesEnabled,
    refreshMe,
    navigate,
  ]);

  useEffect(() => {
    if (!settled || !growthLandingPagesEnabled) return;
    void startTrial();
  }, [settled, growthLandingPagesEnabled, startTrial]);

  useEffect(() => {
    if (chatId) return;
    if (settled && !growthLandingPagesEnabled) navigate("/", { replace: true });
  }, [chatId, settled, growthLandingPagesEnabled, navigate]);

  const actionStartedRef = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Already-onboarded users skip onboarding: hand the scan findings straight to
  // their default agent as a task chat. The handoff flag is cleared only after
  // the chat exists — on failure it stays, and re-clicking the fix link retries.
  const startActionChat = useCallback(async () => {
    if (!actionHandoff || !actionCampaign || actionStartedRef.current) return;
    actionStartedRef.current = true;
    setActionError(null);
    try {
      const { agent } = await getNewChatDefaultCandidates({});
      if (!agent) {
        throw new Error("No connected agent yet. Connect your computer, then open the fix link again.");
      }
      const created = await createMeTaskChat({
        mode: "task",
        topic: actionCampaign.action.topic,
        campaignAction: { campaign: actionHandoff.campaign, repoSlug: actionHandoff.repoSlug },
        initialRecipientAgentIds: [agent.uuid],
        initialRecipientNames: [],
        contextParticipantAgentIds: [],
        contextParticipantNames: [],
        initialMessage: {
          format: "text",
          content: buildCampaignActionBootstrap(
            agent.displayName || "your agent",
            actionCampaign.action,
            { repoUrl: actionHandoff.url, reportKey: actionHandoff.reportKey },
            "direct",
          ),
          source: "web",
        },
      });
      writeCampaignActionHandoffFlag(null);
      navigate(`/?c=${encodeURIComponent(created.chatId)}`, { replace: true });
    } catch (err) {
      actionStartedRef.current = false;
      setActionError(err instanceof Error ? err.message : "Couldn't start the campaign task. Please try again.");
    }
  }, [actionHandoff, actionCampaign, navigate]);

  useEffect(() => {
    if (!actionHandoff || !actionCampaign || !settled || !growthLandingPagesEnabled || !meLoaded) return;
    writeCampaignActionHandoffFlag({
      campaign: actionHandoff.campaign,
      repoUrl: actionHandoff.url,
      reportKey: actionHandoff.reportKey,
      repoSlug: actionHandoff.repoSlug,
    });
    // Direct-chat eligibility is `shouldLeaveOnboarding` — the membership is
    // terminally done (past connect, has a personal agent, AND carries the
    // completion stamp). Its inverse gate, `shouldEnterOnboarding`, returns
    // false for a "finish later" (dismissed) membership, which is only an
    // auto-entry suppressor — using it here would misroute dismissed-but-
    // incomplete members into the direct-chat path. `meLoaded` is re-checked
    // in the guard above because both gates return false on unloaded /me.
    if (
      shouldLeaveOnboarding({
        meLoaded,
        onboardingStep,
        onboardingSuppressedAt: onboardingDismissedAt,
        currentOrgHasPersonalAgent,
        onboardingCompletedAt,
      })
    ) {
      void startActionChat();
    } else {
      navigate("/onboarding", { replace: true });
    }
  }, [
    actionHandoff,
    actionCampaign,
    settled,
    growthLandingPagesEnabled,
    meLoaded,
    onboardingStep,
    onboardingDismissedAt,
    onboardingCompletedAt,
    currentOrgHasPersonalAgent,
    navigate,
    startActionChat,
  ]);

  // Canonicalize a legacy `?chat=<id>` trial link to `?c=<id>` (only when no
  // `?c=` is already present) so pre-migration URLs keep opening the trial chat.
  useEffect(() => {
    if (!chatId && legacyChatId) {
      navigate(`/quickstart?c=${encodeURIComponent(legacyChatId)}`, { replace: true });
    }
  }, [chatId, legacyChatId, navigate]);

  const retryStart = useCallback(() => {
    void startTrial();
  }, [startTrial]);

  const retryActionChat = useCallback(() => {
    void startActionChat();
  }, [startActionChat]);

  // Trial started: render the real workspace shell — as trial chrome, since
  // this is the `/quickstart` route (stripped header + no rail; see Layout /
  // WorkspaceBody `isLandingTrialSurface`) — with the trial chat selected via
  // `?c=`. This route sits inside the Layout group but is NOT the
  // onboarding-gated index route, so an un-onboarded trial user is not bounced
  // to /onboarding — and there is no bespoke trial-chat page to maintain.
  if (chatId) return <WorkspaceBody />;

  // A legacy `?chat=` link is being canonicalized to `?c=` (effect above) —
  // hold a neutral screen for the one tick before the `?c=` URL renders, so we
  // don't flash the no-chat state.
  if (legacyChatId) {
    return (
      <QuickstartShell>
        <StatusRow state="waiting" label="Loading..." />
      </QuickstartShell>
    );
  }

  if (!settled || !growthLandingPagesEnabled) {
    return (
      <QuickstartShell>
        <StatusRow state="waiting" label="Loading..." />
      </QuickstartShell>
    );
  }

  // A fix conversion in flight: hold the launcher shell while the effect above
  // routes to onboarding or opens the direct fix chat; surface failures with a
  // retry (the stored handoff survives, so retrying is safe).
  if (actionHandoff) {
    return (
      <QuickstartShell repoSlug={actionHandoff.repoSlug}>
        <h1 className="text-title" style={{ margin: 0 }}>
          Starting your next step...
        </h1>

        {actionError ? (
          <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
            <FlowHint tone="error" role="alert">
              {actionError}
            </FlowHint>
            <div className="flex">
              <Button type="button" onClick={retryActionChat}>
                <span>Try again</span>
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ) : (
          <WorkingState label="Opening your task chat..." hint="Handing the campaign findings to your agent." />
        )}
      </QuickstartShell>
    );
  }

  // No chat selected and no valid campaign handoff to launch — e.g. the user
  // closed/backed out of the trial chat, or opened /quickstart without a scan
  // link. Render the trial workspace body (no rail on this surface); with no
  // `?c=` it shows NoChatView's trial empty state, which points back to the
  // header "Set up First Tree" CTA rather than a create-chat dead-end.
  if (!intent || !campaign) return <WorkspaceBody />;

  return (
    <QuickstartShell repoSlug={intent.repoSlug}>
      <h1 className="text-title" style={{ margin: 0 }}>
        Starting your trial...
      </h1>

      {startError ? (
        <div className="flex flex-col" style={{ gap: "var(--sp-4)" }}>
          <FlowHint tone="error" role="alert">
            {startError}
          </FlowHint>
          <div className="flex">
            <Button type="button" onClick={retryStart}>
              <span>Try again</span>
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : (
        <WorkingState
          label="Preparing your First Tree agent..."
          hint="Creating a hosted trial chat and starting the first run."
        />
      )}
    </QuickstartShell>
  );
}

function QuickstartShell({ repoSlug, children }: { repoSlug?: string; children: ReactNode }) {
  // `flex-1` (not `min-h-screen`): this launcher now renders inside the
  // workspace Layout outlet, so it fills the available area under the header
  // rather than forcing a full-viewport block that would overflow past it.
  return (
    <div
      className="flex flex-1 flex-col items-center justify-center overflow-y-auto"
      style={{ background: "var(--bg)", color: "var(--fg)", padding: "var(--sp-8) var(--sp-5)" }}
    >
      <div className="flex w-full flex-col" style={{ maxWidth: "30rem", gap: "var(--sp-5)" }}>
        <div className="inline-flex items-center text-label" style={{ gap: "var(--sp-2)", color: "var(--fg-3)" }}>
          <span
            aria-hidden="true"
            style={{
              width: "var(--sp-2_5)",
              height: "var(--sp-2_5)",
              borderRadius: "var(--radius-full)",
              background: "var(--brand)",
            }}
          />
          First Tree
        </div>
        {repoSlug ? (
          <span
            className="inline-flex items-center text-label"
            style={{
              alignSelf: "flex-start",
              gap: "var(--sp-1_5)",
              padding: "var(--sp-1) var(--sp-2_5)",
              border: "var(--hairline) solid var(--border)",
              borderRadius: "var(--radius-full)",
              color: "var(--fg-2)",
            }}
          >
            {repoSlug}
          </span>
        ) : null}
        {children}
      </div>
    </div>
  );
}
