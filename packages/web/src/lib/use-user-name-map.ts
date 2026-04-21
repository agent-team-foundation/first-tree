import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { listMembers } from "../api/members.js";

/**
 * userId → display-name lookup. Clients carry `user_id`, not member_id, so
 * listings that want to show "owner" need to cross a member row to surface
 * the display name. Members-per-user is 1:1 in the current schema (one
 * membership per user per org).
 */
export function useUserNameMap(): (userId: string | null | undefined) => string {
  const { data } = useQuery({
    queryKey: ["members", "user-name-map"],
    queryFn: listMembers,
    staleTime: 30_000,
  });

  return useMemo(() => {
    const map = new Map<string, string>();
    if (data) {
      for (const m of data) {
        map.set(m.userId, m.displayName || m.username);
      }
    }
    return (userId: string | null | undefined) => {
      if (!userId) return "—";
      return map.get(userId) ?? userId;
    };
  }, [data]);
}
