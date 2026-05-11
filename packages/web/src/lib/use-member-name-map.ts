import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { listMembers } from "../api/members.js";

/**
 * Shared hook that builds a member ID → display name lookup map.
 * Used by pages that display managerId references on agents.
 */
export function useMemberNameMap(): (memberId: string | null | undefined) => string {
  const { data } = useQuery({
    queryKey: ["members", "name-map"],
    queryFn: listMembers,
    staleTime: 30_000,
  });

  return useMemo(() => {
    const map = new Map<string, string>();
    if (data) {
      for (const m of data) {
        map.set(m.id, m.displayName || m.username);
      }
    }
    return (memberId: string | null | undefined) => {
      if (!memberId) return "\u2014";
      return map.get(memberId) ?? memberId;
    };
  }, [data]);
}
