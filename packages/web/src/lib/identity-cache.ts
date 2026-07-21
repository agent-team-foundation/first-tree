import type { QueryClient } from "@tanstack/react-query";

/**
 * Invalidate every Web projection that carries a mutable identity label.
 *
 * `displayName` is copied into chat-detail participants as well as roster and
 * conversation projections. Keeping this fan-out in one place prevents a
 * rename surface from refreshing its own form while leaving an already-open
 * chat timeline on the old label.
 */
export async function invalidateDisplayNameQueries(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["members"] }),
    queryClient.invalidateQueries({ queryKey: ["agents"] }),
    queryClient.invalidateQueries({ queryKey: ["managed-agents"] }),
    queryClient.invalidateQueries({ queryKey: ["agent"] }),
    queryClient.invalidateQueries({ queryKey: ["agents-for-delegate"] }),
    queryClient.invalidateQueries({ queryKey: ["context-build", "managed-agents"] }),
    queryClient.invalidateQueries({ queryKey: ["context-reviewer", "org-agents"] }),
    queryClient.invalidateQueries({ queryKey: ["participant-name-cache"] }),
    queryClient.invalidateQueries({ queryKey: ["mobile", "team"] }),
    queryClient.invalidateQueries({ queryKey: ["me", "chats"] }),
    queryClient.invalidateQueries({ queryKey: ["chat-detail"] }),
  ]);
}
