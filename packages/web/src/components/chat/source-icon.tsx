import type { ChatSource, GithubEntityType } from "@first-tree/shared";
import {
  CircleDot,
  GitCommit,
  Github,
  Gitlab,
  GitPullRequest,
  type LucideIcon,
  MessageCircle,
  MessagesSquare,
  Sparkles,
} from "lucide-react";

/**
 * Per-origin Lucide glyph for the conversation-row leading icon.
 *
 * The origin axis stays coarse (`manual` / `github` / `agent`) so the filter
 * popover stays simple, but the rail's visual vocabulary
 * still wants per-entity icons inside GitHub — a PR row should read
 * differently from an Issue row at a glance. The renderer therefore
 * looks at `(source, entityType)` together: github + a known entityType
 * picks the entity-specific glyph; github with `entityType === null` (or
 * a future entity type we haven't mapped yet) falls back to the
 * GitHub-default `Github` mark.
 *
 * Manual and agent-created chats render source-level glyphs so
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
  github: Github,
  gitlab: Gitlab,
  agent: Sparkles,
};

const GITHUB_ENTITY_ICON_MAP: Record<GithubEntityType, LucideIcon> = {
  pull_request: GitPullRequest,
  issue: CircleDot,
  discussion: MessageCircle,
  commit: GitCommit,
};

const SOURCE_LABEL_MAP: Record<ChatSource, string> = {
  manual: "Human-created chat",
  github: "GitHub",
  gitlab: "GitLab",
  agent: "Agent-created task",
};

const GITHUB_ENTITY_LABEL_MAP: Record<GithubEntityType, string> = {
  pull_request: "Pull request",
  issue: "Issue",
  discussion: "Discussion",
  commit: "Commit",
};

export function SourceIcon({
  source,
  entityType = null,
  emphasize = false,
  size = 16,
}: {
  source: ChatSource | undefined;
  /**
   * Within-origin sub-type from `MeChatRow.entityType`. Only consulted
   * when `source === "github"`. Null / undefined for `manual` rows; the
   * renderer falls through to the source-level icon.
   */
  entityType?: GithubEntityType | null;
  /** When true, render at full `--fg` (used on rows with unread mentions). */
  emphasize?: boolean;
  size?: number;
}) {
  // Three-layer fallback:
  //   1. `source === "github"` + a known `entityType` → entity glyph.
  //   2. Otherwise → source-level glyph (`Github` for github with null
  //      entityType, `MessagesSquare` for manual).
  //   3. `source` itself is missing (old server build that doesn't yet
  //      include the field) → Manual placeholder, matches Phase A's
  //      defence-in-depth narrowing.
  //
  // `hasOwnProperty.call` (rather than `in`) so a stray string that
  // names a built-in `Object.prototype` member (`"constructor"`,
  // `"toString"`, …) can never accidentally satisfy the membership
  // check across version skew. The TypeScript types narrow
  // `entityType` / `source` to known unions today, but the runtime
  // input is raw JSON from the server, so the defensive check costs
  // nothing. (We'd use the cleaner `Object.hasOwn` if the web
  // package's tsconfig target was bumped to ES2022.)
  const hasOwn = Object.prototype.hasOwnProperty;
  let Icon: LucideIcon = MessagesSquare;
  let label = "Conversation";
  if (source === "github" && entityType !== null && hasOwn.call(GITHUB_ENTITY_ICON_MAP, entityType)) {
    Icon = GITHUB_ENTITY_ICON_MAP[entityType];
    label = GITHUB_ENTITY_LABEL_MAP[entityType];
  } else if (source !== undefined && hasOwn.call(SOURCE_ICON_MAP, source)) {
    Icon = SOURCE_ICON_MAP[source];
    label = SOURCE_LABEL_MAP[source];
  }
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
