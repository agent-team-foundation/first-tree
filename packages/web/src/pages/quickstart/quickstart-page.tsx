import { ArrowRight } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { startLandingCampaign } from "../../api/landing-campaigns.js";
import { useAuth } from "../../auth/auth-context.js";
import { Button } from "../../components/ui/button.js";
import { useGrowthLandingPagesState } from "../../hooks/use-server-channel.js";
import { FlowHint, StatusRow, WorkingState } from "../onboarding/flow-ui.js";
import { WorkspaceBody } from "../workspace/index.js";
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
  // The trial chat is selected with the normal workspace `?c=` param so
  // `WorkspaceBody` picks it up unchanged — no bespoke `?chat=` handoff.
  const chatId = useMemo(() => new URLSearchParams(location.search).get("c"), [location.search]);
  // Back-compat: trials minted before this migration used `?chat=<id>`.
  // Canonicalize such a legacy URL to `?c=` (effect below) so an already-open
  // trial tab, bookmark, copied link, or reload still opens the trial chat
  // instead of silently falling through to the conversation rail.
  const legacyChatId = useMemo(() => new URLSearchParams(location.search).get("chat"), [location.search]);

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
      navigate(`/quickstart?c=${encodeURIComponent(trialChatId)}`, { replace: true });
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

  // Trial started: render the real workspace shell (full chrome) with the
  // trial chat selected via `?c=`. This route sits inside the Layout group
  // but is NOT the onboarding-gated index route, so an un-onboarded trial
  // user sees the normal workspace here instead of being bounced to
  // /onboarding — and there is no bespoke trial-chat page to maintain.
  if (chatId) return <WorkspaceBody />;

  // A legacy `?chat=` link is being canonicalized to `?c=` (effect above) —
  // hold a neutral screen for the one tick before the `?c=` URL renders, so we
  // don't flash the no-selection rail.
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

  // No chat selected and no valid campaign handoff to launch — e.g. the user
  // closed/backed out of the trial chat, or opened /quickstart without a scan
  // link. Keep them in the real workspace (conversation rail) rather than a
  // dead-end card: WorkspaceBody with no `?c=` shows their conversation list.
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
