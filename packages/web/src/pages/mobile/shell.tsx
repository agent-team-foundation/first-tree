import { useQuery } from "@tanstack/react-query";
import { Navigate, Outlet, useLocation, useSearchParams } from "react-router";
import { listMeChats } from "../../api/me-chats.js";
import { useAuth } from "../../auth/auth-context.js";
import { TeamSwitchOverlay } from "../../components/team-switch-overlay.js";
import { useAdminWs } from "../../hooks/use-admin-ws.js";
import { shouldEnterOnboarding } from "../onboarding/steps.js";
import { MobileBottomTabs, MobileTopBar } from "./components.js";
import { countAttentionRows, countUnreadRows } from "./data.js";

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

  const tabCountsQuery = useQuery({
    queryKey: ["mobile", "tab-counts", organizationId],
    queryFn: () => listMeChats({ limit: 50, engagement: "active" }),
    enabled: !!organizationId,
    refetchInterval: 30_000,
  });

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

  const selectedChatId = searchParams.get("c");
  const immersiveChat = location.pathname === "/m/chat" && selectedChatId !== null;
  const rows = tabCountsQuery.data?.rows ?? [];

  return (
    <div
      className="flex flex-col overflow-hidden"
      style={{
        height: "100vh",
        minHeight: "100dvh",
        background: "var(--bg)",
      }}
    >
      {immersiveChat ? null : <MobileTopBar title={mobileTitle(location.pathname)} />}
      <TeamSwitchOverlay />
      <main className="flex-1 min-h-0 overflow-hidden">
        <Outlet />
      </main>
      {immersiveChat ? null : (
        <MobileBottomTabs attentionCount={countAttentionRows(rows)} unreadCount={countUnreadRows(rows)} />
      )}
    </div>
  );
}

function mobileTitle(pathname: string): string {
  if (pathname.startsWith("/m/chat")) return "Chat";
  if (pathname.startsWith("/m/team")) return "Team";
  if (pathname.startsWith("/m/me")) return "Me";
  return "Today";
}
