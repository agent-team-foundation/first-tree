import type { ChatGithubEntity, GithubEntityLiveState, GithubEntityType } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { CircleDot, ExternalLink, GitCommit, GitMerge, GitPullRequest, MessageCircle } from "lucide-react";
import { listChatGithubEntities } from "../../../api/chats.js";
import { DenseBadge, type DenseBadgeTone } from "../../../components/ui/dense-badge.js";

/**
 * GitHub section — lists every PR / Issue / Discussion / Commit bound to
 * the current chat via `github_entity_chat_mappings`. Live title + state
 * are fetched per-request by the server from the GitHub REST API and are
 * NOT persisted; rows degrade gracefully (link only) when the GitHub
 * round-trip fails or the org has no installation.
 *
 * Hidden entirely when the chat has no bindings — empty rails would
 * waste vertical space on chats that aren't sourced from GitHub.
 */
export function GitHubSection({ chatId }: { chatId: string }) {
  const query = useQuery({
    queryKey: ["chat-right-sidebar", "github-entities", chatId],
    queryFn: () => listChatGithubEntities(chatId),
    // GitHub live state can drift between sessions; refresh every 60s when
    // the panel is open, and treat the data as fresh for ~30s so quick
    // panel toggles do not refetch.
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const items = query.data?.items ?? [];

  if (query.isLoading || items.length === 0) {
    // Loading / empty: render nothing. The Agents section already covered
    // the "right rail has content" cue; an extra spinner would just churn
    // the layout.
    return null;
  }

  return (
    <section>
      <div className="text-eyebrow" style={{ padding: "var(--sp-2_5) var(--sp-3) var(--sp-1)", color: "var(--fg-4)" }}>
        GitHub <span className="mono">· {items.length}</span>
      </div>

      <div className="flex flex-col" style={{ padding: "0 var(--sp-2) var(--sp-2)", gap: 2 }}>
        {items.map((entity) => (
          <GitHubRow key={`${entity.entityType}::${entity.entityKey}`} entity={entity} />
        ))}
      </div>
    </section>
  );
}

function GitHubRow({ entity }: { entity: ChatGithubEntity }) {
  const Icon = iconForType(entity.entityType, entity.state);
  const view = viewForState(entity.state);

  return (
    <a
      href={entity.htmlUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex items-start transition-colors hover:bg-[var(--bg-hover)]"
      style={{
        gap: "var(--sp-2)",
        padding: "var(--sp-2)",
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
      <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 3 }}>
        <div className="mono text-label flex items-center" style={{ gap: "var(--sp-1_5)", color: "var(--fg-2)" }}>
          <span>{entity.entityKey}</span>
          {view ? <DenseBadge tone={view.tone}>{view.label}</DenseBadge> : null}
        </div>
        {entity.title ? (
          <div
            className="text-body"
            style={{
              color: "var(--fg)",
              overflow: "hidden",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
            }}
          >
            {entity.title}
          </div>
        ) : null}
        <div className="text-caption" style={{ color: "var(--fg-4)" }}>
          {humanizeBoundVia(entity.boundVia)}
        </div>
      </div>
      <ExternalLink
        aria-hidden="true"
        size={12}
        className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
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

/**
 * Map the wire-level `bound_via` enum (`direct` / `fixes_link` /
 * `human_fallback` / `agent_declared` / `human_declared`) to a
 * self-contained sentence — the row doesn't prepend "via " anymore, so
 * each label has to read as a complete provenance hint on its own.
 * Falling back to the raw key preserves forward-compatibility for any
 * new boundVia value the server might emit before this map catches up.
 */
function humanizeBoundVia(boundVia: string): string {
  switch (boundVia) {
    case "direct":
      return "Mentioned in chat";
    case "fixes_link":
      return 'Auto-linked from "Fixes #…"';
    case "human_fallback":
      return "Routed to your existing chat";
    case "agent_declared":
      return "Followed by an agent";
    case "human_declared":
      return "Followed by you";
    default:
      return boundVia;
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
