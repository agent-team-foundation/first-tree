/**
 * Composes the toast / inline message rendered alongside the Save button on
 * the agent-detail page. The phrasing differs depending on whether the
 * agent has a bound computer, whether that computer is reachable, and how
 * many chats are currently running — saying "configuration stored; will
 * apply when a computer claims this agent" is honest and useful where
 * "Saved" would silently mislead.
 */
export function deriveSaveHint(opts: { activeSessions: number; isUnclaimed: boolean; isOffline: boolean }): string {
  if (opts.isUnclaimed) {
    return "Saving: configuration stored; will apply when a computer claims this agent.";
  }
  if (opts.isOffline) {
    return "Saving: configuration stored; will apply when the computer reconnects.";
  }
  if (opts.activeSessions > 0) {
    return `Saving: new chats use this immediately; ${opts.activeSessions} active chat${
      opts.activeSessions === 1 ? "" : "s"
    } switch on their next message.`;
  }
  return "Saving: new chats use this immediately.";
}
