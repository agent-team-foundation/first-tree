import type { ChatGithubEntity, GithubEntityLiveState, GithubEntityType } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { CircleDot, ExternalLink, GitCommit, GitMerge, GitPullRequest, MessageCircle } from "lucide-react";
import { listChatGithubEntities } from "../../../api/chats.js";
import { DenseBadge, type DenseBadgeTone } from "../../../components/ui/dense-badge.js";

/**
 * Shared query for a chat's bound GitHub entities. Used by GitHubSection to
 * render the list AND by ChatRightSidebar to decide whether Summary is the last
 * visible section (and therefore uncapped). Same query key → React Query
 * dedupes the two call sites to a single request.
 */
export function useChatGithubEntities(chatId: string): {
  items: ChatGithubEntity[];
  isLoading: boolean;
  isError: boolean;
  retry: () => void;
} {
  const query = useQuery({
    queryKey: ["chat-right-sidebar", "github-entities", chatId],
    queryFn: () => listChatGithubEntities(chatId),
    // Webhook-synced state can drift while the panel is open; refresh the
    // cheap DB projection periodically and keep quick panel toggles warm.
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  return {
    items: query.data?.items ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    retry: () => {
      void query.refetch();
    },
  };
}

/**
 * GitHub section — lists every PR / Issue / Discussion / Commit bound to
 * the current chat via `github_entity_chat_mappings`. State comes from the
 * server's webhook-synced projection; title may be null because the mapping
 * table does not persist titles, so rows degrade gracefully to link-only.
 *
 * Hidden entirely when the chat has no bindings — empty rails would
 * waste vertical space on chats that aren't sourced from GitHub.
 */
export function GitHubSection({ chatId, variant = "sidebar" }: { chatId: string; variant?: "sidebar" | "mobile" }) {
  const { items, isLoading, isError, retry } = useChatGithubEntities(chatId);

  if (isLoading) {
    // Loading / empty: render nothing. The Agents section already covered
    // the "right rail has content" cue; an extra spinner would just churn
    // the layout.
    return null;
  }

  if (isError && items.length === 0 && variant === "mobile") {
    return (
      <section data-mobile-github-section="true" style={{ borderTop: "var(--hairline) solid var(--border-faint)" }}>
        <div
          className="flex items-center text-mobile-body"
          style={{ minHeight: 44, gap: "var(--sp-3)", padding: "var(--sp-3) var(--sp-4)", color: "var(--fg-3)" }}
        >
          <span style={{ flex: 1 }}>GitHub links could not be loaded.</span>
          <button
            type="button"
            onClick={retry}
            className="inline-flex min-h-11 items-center rounded-[var(--radius-input)] border px-3"
            style={{ borderColor: "var(--border)", color: "var(--fg)" }}
          >
            Retry
          </button>
        </div>
      </section>
    );
  }

  if (items.length === 0) return null;

  // Group by type so same-kind entities cluster — PRs (the primary work
  // artifact) first, then issues, discussions, commits. Type is conveyed by
  // the per-row icon alone (no subheaders).
  const sorted = sortEntitiesByType(items);

  return (
    <section
      data-mobile-github-section={variant === "mobile" ? "true" : undefined}
      style={variant === "mobile" ? { borderTop: "var(--hairline) solid var(--border-faint)" } : undefined}
    >
      <div
        className={variant === "mobile" ? "text-mobile-subtitle" : "text-eyebrow"}
        style={{
          padding:
            variant === "mobile" ? "var(--sp-4) var(--sp-4) var(--sp-2)" : "var(--sp-2_5) var(--sp-3) var(--sp-1)",
          color: variant === "mobile" ? "var(--fg)" : "var(--fg-4)",
        }}
      >
        GitHub <span className="mono">· {items.length}</span>
        {variant === "mobile" ? (
          <div className="text-mobile-caption" style={{ color: "var(--fg-4)", marginTop: "var(--sp-1)" }}>
            Following in this chat
          </div>
        ) : null}
      </div>

      {/* Inter-row gap (--sp-1_5) is deliberately larger than the intra-row
          line gap (the tight title-to-reference gap below). Rows are multi-line
          once titles render, so the larger outer gap is what makes each entity
          read as one grouped block instead of the lines bleeding together. */}
      <div
        className="flex flex-col"
        style={{
          padding: variant === "mobile" ? "0 var(--sp-2) var(--sp-4)" : "0 var(--sp-2) var(--sp-2)",
          gap: variant === "mobile" ? "var(--sp-1)" : "var(--sp-1_5)",
        }}
      >
        {sorted.map((entity) => (
          <GitHubRow key={`${entity.entityType}::${entity.entityKey}`} entity={entity} mobile={variant === "mobile"} />
        ))}
      </div>
    </section>
  );
}

/** Group order for the GitHub list: PR → Issue → Discussion → Commit. */
const TYPE_ORDER: Record<string, number> = {
  pull_request: 0,
  issue: 1,
  discussion: 2,
  commit: 3,
};

function typeRank(type: GithubEntityType): number {
  return TYPE_ORDER[type] ?? 9;
}

/**
 * Cluster entities by type (PR → Issue → Discussion → Commit) without
 * subheaders — the per-row icon carries the type. `Array.prototype.sort` is
 * stable, so server order is preserved within each type group. Pure + exported
 * for unit testing (the panel itself needs live bindings to render).
 */
export function sortEntitiesByType(items: ChatGithubEntity[]): ChatGithubEntity[] {
  return [...items].sort((a, b) => typeRank(a.entityType) - typeRank(b.entityType));
}

/**
 * Drop the `owner/` prefix so the reference line reads `repo#42` instead of
 * `owner/repo#42`. The title now carries the meaning, the repo disambiguates,
 * and the org is rarely needed in-rail — it stays available on hover (the full
 * `entityKey` is the row's `title` attribute) and in the link target. Falls
 * back to the full key when there is no `/` to split on.
 */
function compactEntityRef(entityKey: string): string {
  const slash = entityKey.indexOf("/");
  return slash >= 0 ? entityKey.slice(slash + 1) : entityKey;
}

function GitHubRow({ entity, mobile = false }: { entity: ChatGithubEntity; mobile?: boolean }) {
  const Icon = iconForType(entity.entityType, entity.state);
  const view = viewForState(entity.state);
  const hasTitle = Boolean(entity.title && entity.title.length > 0);
  // Reference text: the compact `repo#number` when a title leads the row, or
  // the full `owner/repo#number` when the reference IS the primary line (no
  // title) and needs to stand alone.
  const referenceText = hasTitle ? compactEntityRef(entity.entityKey) : entity.entityKey;

  return (
    <a
      href={entity.htmlUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex items-start transition-colors hover:bg-[var(--bg-hover)]"
      style={{
        gap: "var(--sp-2)",
        minHeight: mobile ? 44 : undefined,
        padding: mobile ? "var(--sp-2) var(--sp-3)" : "var(--sp-1_5) var(--sp-2)",
        borderRadius: "var(--radius-input)",
        color: "inherit",
        textDecoration: "none",
      }}
    >
      <Icon
        aria-hidden="true"
        className="shrink-0"
        size={16}
        strokeWidth={1.75}
        style={{ marginTop: 2, color: iconColor(entity.state) }}
      />
      <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 2 }}>
        {/* Primary line: the human title when present — what the eye scans
            first. The bare entityKey carries no meaning, so it never leads;
            when there is no title the reference line below stands in. */}
        {hasTitle ? (
          <div
            className={mobile ? "text-mobile-body" : "text-body"}
            style={{
              color: "var(--fg)",
              overflow: "hidden",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
            }}
            title={entity.title ?? undefined}
          >
            {entity.title}
          </div>
        ) : null}
        {/* Reference + status. Muted and secondary when a title leads; promoted
            to the primary line (stronger color) when it stands alone. */}
        <div
          className="mono text-label flex items-center"
          style={{ gap: "var(--sp-1_5)", color: hasTitle ? "var(--fg-3)" : "var(--fg-2)" }}
        >
          <span
            className="min-w-0"
            style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            title={entity.entityKey}
          >
            {referenceText}
          </span>
          {view ? <DenseBadge tone={view.tone}>{view.label}</DenseBadge> : null}
        </div>
      </div>
      <ExternalLink
        aria-hidden="true"
        size={12}
        className={mobile ? "shrink-0 opacity-100" : "shrink-0 opacity-0 transition-opacity group-hover:opacity-100"}
        style={{ marginTop: 4, color: "var(--fg-3)" }}
      />
    </a>
  );
}

function iconForType(type: GithubEntityType, state: GithubEntityLiveState | null) {
  if (type === "pull_request") return state === "merged" ? GitMerge : GitPullRequest;
  if (type === "issue") return CircleDot;
  if (type === "discussion") return MessageCircle;
  return GitCommit;
}

function iconColor(state: GithubEntityLiveState | null): string {
  switch (state) {
    case "merged":
      return "oklch(0.42 0.18 295)";
    case "closed":
      return "var(--fg-3)";
    case "draft":
      return "var(--fg-4)";
    case "open":
      return "var(--fg-success-strong)";
    default:
      return "var(--fg-3)";
  }
}

function viewForState(state: GithubEntityLiveState | null): { label: string; tone: DenseBadgeTone } | null {
  if (!state) return null;
  switch (state) {
    case "open":
      return { label: "Open", tone: "accent" };
    case "closed":
      return { label: "Closed", tone: "neutral" };
    case "merged":
      // Mapped to `outline` since the DenseBadge palette doesn't carry a
      // purple/merged tone; the icon swap to GitMerge does the heavy
      // lifting for the visual signal.
      return { label: "Merged", tone: "outline" };
    case "draft":
      return { label: "Draft", tone: "outline" };
    default:
      return null;
  }
}
