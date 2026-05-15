import type { ChatSource } from "@agent-team-foundation/first-tree-hub-shared";
import {
  CircleDot,
  GitCommit,
  GitPullRequest,
  type LucideIcon,
  MessageCircle,
  MessageSquare,
  MessagesSquare,
} from "lucide-react";

/**
 * Per-source Lucide glyph for the conversation-row leading icon.
 *
 * Manual chats render `MessagesSquare` as an intentional placeholder so
 * every row reserves the same leading-icon slot — without that, the
 * title's left-edge would drift between rows of different sources and
 * the list would look jagged.
 *
 * Colour is intentionally single-tone (`--fg-3` / `--fg`) rather than
 * per-source themed. Source palettes would compete with the unread
 * badge's `--state-error` red and turn the rail into a colour swatch.
 */
const SOURCE_ICON_MAP: Record<ChatSource, LucideIcon> = {
  manual: MessagesSquare,
  github_pull_request: GitPullRequest,
  github_issue: CircleDot,
  github_discussion: MessageCircle,
  github_commit: GitCommit,
  feishu: MessageSquare,
};

const SOURCE_LABEL_MAP: Record<ChatSource, string> = {
  manual: "Manual chat",
  github_pull_request: "Pull request",
  github_issue: "Issue",
  github_discussion: "Discussion",
  github_commit: "Commit",
  feishu: "Feishu",
};

export function SourceIcon({
  source,
  emphasize = false,
  size = 16,
}: {
  source: ChatSource | undefined;
  /** When true, render at full `--fg` (used on rows with unread mentions). */
  emphasize?: boolean;
  size?: number;
}) {
  // Two-layer fallback:
  //   1. `source` itself may be `undefined` when an older server build
  //      doesn't yet include the `source` column in the row payload
  //      (web rolls before server). `api.get<>` is a plain TS cast,
  //      so the shared schema's `default("manual")` doesn't run at
  //      runtime — we have to defend here.
  //   2. Even when `source` arrives, a future `ChatSource` literal
  //      added to the shared enum without a corresponding map entry
  //      would otherwise render `<undefined />` and crash React.
  //
  // Both cases collapse to the Manual placeholder so the row still
  // renders. Manual is the visually quietest fallback (`MessagesSquare`)
  // and the label preserves the unknown source's identity in screen
  // readers via the source key.
  const Icon = (source && SOURCE_ICON_MAP[source]) ?? MessagesSquare;
  const label = (source && SOURCE_LABEL_MAP[source]) ?? "Conversation";
  return (
    <Icon
      role="img"
      aria-label={label}
      size={size}
      strokeWidth={1.75}
      style={{
        color: emphasize ? "var(--fg)" : "var(--fg-3)",
        flexShrink: 0,
      }}
    />
  );
}
