import type { ChatContext } from "./chat-context.js";

/**
 * Render the per-chat "Current Chat Context" markdown section. This material
 * must stay out of shared AGENTS.md / CLAUDE.md and be delivered through the
 * handler's provider/session prompt path for the current chat.
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
  // the `## Chat Topic & Description` subsection of the unified briefing
  // (`runtime/agent-briefing.ts`) for the two hard rules the agent is
  // expected to follow when it sees `(unset)` here.
  if (chatContext.topic && chatContext.topic.trim().length > 0) {
    lines.push(`- Topic: ${chatContext.topic}`);
  } else {
    lines.push(`- Topic: (unset — see "Chat Topic & Description" in the shared briefing)`);
  }
  // Description is the raw `chats.description` column — a running
  // "what + current state" summary, rendered every turn (value or
  // sentinel) so the agent can decide whether to write/refresh it.
  if (chatContext.description && chatContext.description.trim().length > 0) {
    lines.push(`- Description: ${chatContext.description}`);
  } else {
    lines.push(`- Description: (unset — see "Chat Topic & Description" in the shared briefing)`);
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

/**
 * Provider/session prompt payload for the current chat. The wrapper matters
 * for providers without a dedicated system prompt channel, where this block
 * may be prepended to a turn input while still being runtime-authored context.
 */
export function renderChatContextPrompt(chatContext: ChatContext | undefined): string | null {
  const section = renderChatContextSection(chatContext);
  if (!section) return null;
  return [
    "<first-tree-current-chat-context>",
    "The following block is First Tree runtime context for this chat/session, not user-authored content.",
    "",
    section.trimEnd(),
    "</first-tree-current-chat-context>",
  ].join("\n");
}
