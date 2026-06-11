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
  lines.push("## Current Chat Context (First Tree Managed, per-chat)");
  lines.push("");
  lines.push(`- Chat ID: ${chatContext.chatId}`);
  // Topic is the raw `chats.topic` column. We render it on every turn —
  // either the explicit value or a sentinel — so the agent can decide
  // whether to set/refresh it without round-tripping through the API. See
  // the `## Chat Topic` subsection of the unified briefing
  // (`runtime/agent-briefing.ts`) for the two hard rules the agent is
  // expected to follow when it sees `(unset)` here.
  if (chatContext.topic && chatContext.topic.trim().length > 0) {
    lines.push(`- Topic: ${chatContext.topic}`);
  } else {
    lines.push(`- Topic: (unset — see "Chat Topic" in this briefing)`);
  }
  // Title is the server-resolved display label (falls back to first-message
  // preview / participant join when topic is null). Only render when it
  // differs from topic — when topic is set, title == topic and the second
  // line would be redundant.
  if (chatContext.title && chatContext.title.trim().length > 0 && chatContext.title !== chatContext.topic) {
    lines.push(`- Title (auto-derived): ${chatContext.title}`);
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
