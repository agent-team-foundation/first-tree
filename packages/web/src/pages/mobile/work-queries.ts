import type { ChatEngagementView, MeChatFilter } from "@first-tree/shared";
import { listMeChatSourceCounts, listMeChats } from "../../api/me-chats.js";

const MOBILE_WORK_PAGE_SIZE = 50;
const MOBILE_WORK_POLL_MS = 30_000;
const MOBILE_WORK_STALE_MS = 15_000;

type MobileWorkQueryScope = {
  organizationId: string | null;
  engagement: ChatEngagementView;
  watching: boolean;
};

export function mobileWorkListQueryOptions(scope: MobileWorkQueryScope & { filter: MeChatFilter }) {
  return {
    queryKey: [
      "me",
      "chats",
      "mobile",
      "work-list",
      scope.organizationId,
      scope.engagement,
      scope.watching,
      scope.filter,
    ] as const,
    queryFn: ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) =>
      listMeChats(
        {
          cursor: pageParam,
          limit: MOBILE_WORK_PAGE_SIZE,
          engagement: scope.engagement,
          filter: scope.filter,
          watching: scope.watching ? true : undefined,
        },
        { signal },
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: Awaited<ReturnType<typeof listMeChats>>) => lastPage.nextCursor ?? undefined,
    staleTime: MOBILE_WORK_STALE_MS,
    refetchInterval: MOBILE_WORK_POLL_MS,
  };
}

export function mobileWorkSourceCountsQueryOptions(scope: MobileWorkQueryScope) {
  return {
    queryKey: [
      "me",
      "chats",
      "mobile",
      "work-source-counts",
      scope.organizationId,
      scope.engagement,
      scope.watching,
    ] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      listMeChatSourceCounts(
        {
          engagement: scope.engagement,
          watching: scope.watching ? true : undefined,
        },
        { signal },
      ),
    staleTime: MOBILE_WORK_STALE_MS,
    refetchInterval: MOBILE_WORK_POLL_MS,
  };
}
