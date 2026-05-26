/**
 * Whether the chat composer must carry an explicit `@mention` before a send is
 * allowed.
 *
 * Mirrors the server's membership-shape rule (`services/message.ts`
 * `isOneOnOne = participants.length === 2`, speakers only): a 1-on-1 never
 * needs an explicit mention; a real group (3+ speakers) does.
 *
 * Keyed on **speaker count**, NOT `chats.type`. Since the group-chat
 * convergence (first-tree PR 465 / first-tree-context PR 281) every chat
 * is created with `type='group'`, so a `type === "group"` check forced an
 * `@mention` in 1-on-1 DMs too — breaking the "DM doesn't need an explicit
 * @mention" UX. This predicate keys on shape instead, matching the server.
 *
 * `participantAgentIds` must be the chat's **speakers**. `getChatDetail`
 * returns `accessMode = 'speaker'` rows only, and the server's `isOneOnOne`
 * uses the same speaker-filtered list — so the two stay in lockstep.
 *
 * If the current user isn't yet a speaker, their first send promotes them to
 * one, so that prospective seat is counted (a send into a 2-speaker chat the
 * user is only watching makes it a real 3-speaker group).
 */
export function computeRequiresMention(
  participantAgentIds: readonly string[],
  myAgentId: string | null | undefined,
): boolean {
  const meIn = myAgentId != null && participantAgentIds.includes(myAgentId);
  // Effective speaker count once this send lands.
  const speakersAfterSend = participantAgentIds.length + (meIn ? 0 : 1);
  return speakersAfterSend >= 3;
}
