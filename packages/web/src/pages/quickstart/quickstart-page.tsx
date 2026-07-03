import { ArrowRight } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { startLandingCampaign } from "../../api/landing-campaigns.js";
import { useAuth } from "../../auth/auth-context.js";
import { Button } from "../../components/ui/button.js";
import { useGrowthLandingPagesState } from "../../hooks/use-server-channel.js";
import { FlowHint, StatusRow, WorkingState } from "../onboarding/flow-ui.js";
import { ChatByIdView } from "../workspace/center/chat-by-id.js";
import { getCampaign } from "./campaigns.js";
import {
  type CampaignIntent,
  clearCampaignIntent,
  hasCampaignHandoff,
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
  const { organizationId, refreshMe } = useAuth();
  const { enabled: growthLandingPagesEnabled, settled } = useGrowthLandingPagesState();
  const chatId = useMemo(() => new URLSearchParams(location.search).get("chat"), [location.search]);

  const intent = useMemo<CampaignIntent | null>(() => {
    if (chatId) return null;
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
  }, [chatId, location]);
  const campaign = intent ? getCampaign(intent.campaign) : null;

  const startStartedRef = useRef(false);
  const [startError, setStartError] = useState<string | null>(null);

  const startTrial = useCallback(async () => {
    if (chatId || !intent || !campaign || startStartedRef.current || !growthLandingPagesEnabled) return;
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
      navigate(`/quickstart?chat=${encodeURIComponent(trialChatId)}`, { replace: true });
    } catch (err) {
      startStartedRef.current = false;
      setStartError(err instanceof Error ? err.message : "Couldn't open your trial chat. Please try again.");
    }
  }, [chatId, intent, campaign, organizationId, growthLandingPagesEnabled, refreshMe, navigate]);

  useEffect(() => {
    if (!settled || !growthLandingPagesEnabled) return;
    void startTrial();
  }, [settled, growthLandingPagesEnabled, startTrial]);

  useEffect(() => {
    if (chatId) return;
    if (settled && !growthLandingPagesEnabled) navigate("/", { replace: true });
  }, [chatId, settled, growthLandingPagesEnabled, navigate]);

  const retryStart = useCallback(() => {
    void startTrial();
  }, [startTrial]);

  if (chatId) return <QuickstartTrialChat chatId={chatId} />;

  if (!settled || !growthLandingPagesEnabled) {
    return (
      <QuickstartShell>
        <StatusRow state="waiting" label="Loading..." />
      </QuickstartShell>
    );
  }

  if (!intent || !campaign) {
    return (
      <QuickstartShell>
        <h1 className="text-title" style={{ margin: 0 }}>
          Start from a First Tree scan
        </h1>
        <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
          Open this from a First Tree scan link so we know which repo to look at.
        </p>
        <div className="flex">
          <Button asChild>
            <a href="/">Go to your workspace</a>
          </Button>
        </div>
      </QuickstartShell>
    );
  }

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

function QuickstartTrialChat({ chatId }: { chatId: string }) {
  return (
    <div className="flex min-h-screen flex-col" style={{ background: "var(--bg)", color: "var(--fg)" }}>
      <ChatByIdView chatId={chatId} narrow={false} onShowConversations={null} />
    </div>
  );
}

function QuickstartShell({ repoSlug, children }: { repoSlug?: string; children: ReactNode }) {
  return (
    <div
      className="flex min-h-screen flex-col items-center"
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
