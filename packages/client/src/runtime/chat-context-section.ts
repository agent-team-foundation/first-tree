import type { ChatContext } from "./chat-context.js";

/**
 * Render the "Current Chat Context" markdown section that both Claude Code
 * (CLAUDE.md) and Codex (AGENTS.md) inject into the agent's prompt context.
 *
 * Shared so the two handlers never drift on field shape or wording. Returns
 * `null` when there's no context to render — caller skips the section.
 *
 * See proposals/hub-chat-message-v1-design §四 改造 3.
 */
export function renderChatContextSection(chatContext: ChatContext | undefined): string | null {
  if (!chatContext) return null;

  const lines: string[] = [];
  lines.push("## Current Chat Context");
  lines.push("");
  lines.push(`- Chat ID: ${chatContext.chatId}`);
  // Title is server-resolved and always non-empty (falls back to first-message
  // preview / participant join). Topic is the raw column — render it as a
  // separate line only when explicitly set, so the LLM can tell "creator
  // chose this label" from "Hub auto-derived a label".
  if (chatContext.title && chatContext.title.trim().length > 0) {
    lines.push(`- Title: ${chatContext.title}`);
  }
  if (chatContext.topic && chatContext.topic.trim().length > 0 && chatContext.topic !== chatContext.title) {
    lines.push(`- Topic: ${chatContext.topic}`);
  }
  if (chatContext.selfOwner) {
    lines.push(`- Your owner: ${chatContext.selfOwner.displayName} (@${chatContext.selfOwner.name})`);
  }
  lines.push("- Participants:");
  if (chatContext.participants.length === 0) {
    lines.push("  - (none)");
  } else {
    for (const p of chatContext.participants) {
      lines.push(`  - @${p.name} (${p.displayName}, type=${p.type})`);
    }
  }
  return `${lines.join("\n")}\n`;
}
