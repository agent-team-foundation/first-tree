import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Navigate, Outlet, useLocation, useSearchParams } from "react-router";
import { useAuth } from "../../auth/auth-context.js";
import { TeamSwitchOverlay } from "../../components/team-switch-overlay.js";
import { useAdminWs } from "../../hooks/use-admin-ws.js";
import { shouldEnterOnboarding } from "../onboarding/steps.js";
import { MobileBottomTabs } from "./components.js";
import { mobileRowsFromList } from "./data.js";
import { InstallGuideSheet } from "./install-guide-sheet.js";
import { useInstallGuideAuto } from "./use-install-guide.js";
import { mobileWorkListQueryOptions, mobileWorkSourceCountsQueryOptions } from "./work-queries.js";

export function MobileShell() {
  const {
    meLoaded,
    onboardingStep,
    onboardingDismissedAt,
    onboardingCompletedAt,
    currentOrgHasPersonalAgent,
    organizationId,
  } = useAuth();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  useAdminWs();

  const activeWorkScope = {
    organizationId: organizationId ?? null,
    engagement: "active" as const,
    watching: false,
  };
  const tabCountsQuery = useInfiniteQuery({
    ...mobileWorkListQueryOptions({ ...activeWorkScope, filter: "all" }),
    enabled: !!organizationId,
  });
  const unreadCountsQuery = useQuery({
    ...mobileWorkSourceCountsQueryOptions(activeWorkScope),
    enabled: !!organizationId,
  });

  const selectedChatId = searchParams.get("c");
  const workRoute =
    location.pathname === "/m/work" || location.pathname === "/m/now" || location.pathname === "/m/chat";
  const immersiveChat = workRoute && selectedChatId !== null;
  const firstWorkPage = tabCountsQuery.data?.pages[0];
  const rows = mobileRowsFromList(firstWorkPage);
  const attentionRows = firstWorkPage?.priorityRows.attention ?? [];
  const attentionUnread = attentionRows.reduce((count, row) => count + (row.unreadMentionCount > 0 ? 1 : 0), 0);
  const totalUnread = Object.values(unreadCountsQuery.data?.counts ?? {}).reduce(
    (count, source) => count + source.unreadChatCount,
    0,
  );
  const workCount = attentionRows.length + totalUnread - attentionUnread;

  // Kept above the onboarding early-return so hook order stays unconditional.
  const installGuide = useInstallGuideAuto({ hasContent: rows.length > 0, immersive: immersiveChat });

  if (
    shouldEnterOnboarding({
      meLoaded,
      onboardingStep,
      onboardingSuppressedAt: onboardingDismissedAt,
      currentOrgHasPersonalAgent,
      onboardingCompletedAt,
    })
  ) {
    return <Navigate to="/onboarding" replace />;
  }

  return (
    <div className="h-dvh-screen pt-safe-top flex flex-col overflow-hidden" style={{ background: "var(--bg)" }}>
      <TeamSwitchOverlay />
      <main className="flex-1 min-h-0 overflow-hidden">
        <Outlet />
      </main>
      {immersiveChat ? null : <MobileBottomTabs workCount={workCount} />}
      {installGuide.open && installGuide.mode ? (
        <InstallGuideSheet mode={installGuide.mode} onInstall={installGuide.install} onClose={installGuide.dismiss} />
      ) : null}
    </div>
  );
}
