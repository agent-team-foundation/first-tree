import type { AttachmentRef } from "@agent-team-foundation/first-tree-hub-shared";

/**
 * Feishu-specific message formatting. Owns *how* attachments are surfaced to
 * external Feishu users — a filename + size list appended to the text, no
 * internal download links (external users have no Hub session). The Feishu
 * upload API path is a follow-up; until then this is the deliberate downgrade.
 *
 * Lives here (not in `adapter-manager.ts`) so each adapter's "consume
 * `metadata.attachments`" logic stays in its own folder. The manager is the
 * router/dispatcher; per-adapter rendering shouldn't leak back into it.
 */

function formatAttachmentSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Convert an internal message (format + content + attachments) into Feishu
 * `msg_type` + serialised content string for `im.v1.message.create`.
 *
 * Attachments are downgraded to a filename + size list appended to the text —
 * see file header for why. Caller passes `attachments=[]` for messages without
 * any.
 */
export function formatForFeishu(
  format: string,
  content: unknown,
  attachments: AttachmentRef[] = [],
): { msgType: string; content: string } {
  const suffix =
    attachments.length > 0
      ? `\n\n📎 ${attachments.length} attachment${attachments.length > 1 ? "s" : ""}:\n${attachments
          .map((a) => `• ${a.filename} (${formatAttachmentSize(a.size)})`)
          .join("\n")}`
      : "";

  if (format === "text") {
    const text = typeof content === "string" ? content : JSON.stringify(content);
    return { msgType: "text", content: JSON.stringify({ text: text + suffix }) };
  }

  if (format === "markdown") {
    const text = typeof content === "string" ? content : JSON.stringify(content);
    const card = {
      config: { wide_screen_mode: true },
      elements: [{ tag: "markdown", content: text + suffix }],
    };
    return { msgType: "interactive", content: JSON.stringify(card) };
  }

  if (format === "card" && typeof content === "object") {
    return { msgType: "interactive", content: JSON.stringify(content) };
  }

  const text = typeof content === "string" ? content : JSON.stringify(content);
  return { msgType: "text", content: JSON.stringify({ text: text + suffix }) };
}
