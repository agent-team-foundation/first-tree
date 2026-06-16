import type { ReactNode } from "react";
import { Markdown } from "../../../components/ui/markdown.js";

/**
 * Description section — the chat's work summary + status report (set by the
 * owning agent via `chat update --description`), rendered as markdown at the
 * TOP of the right rail, above Participants. Read-only on the web.
 *
 * Hidden entirely when the chat has no description — an empty eyebrow would
 * just waste vertical space on chats that never set one. The trailing
 * hairline mirrors the Participants section so the rail's sections read as a
 * consistent stack.
 */
export function DescriptionSection({ description }: { description: string | null }): ReactNode {
  const trimmed = description?.trim();
  if (!trimmed) return null;

  return (
    <section style={{ borderBottom: "var(--hairline) solid var(--border-faint)" }}>
      <div className="text-eyebrow" style={{ padding: "var(--sp-2_5) var(--sp-3) var(--sp-1)", color: "var(--fg-4)" }}>
        Description
      </div>

      <div className="text-body" style={{ padding: "0 var(--sp-3) var(--sp-2_5)", color: "var(--fg)" }}>
        <Markdown>{trimmed}</Markdown>
      </div>
    </section>
  );
}
