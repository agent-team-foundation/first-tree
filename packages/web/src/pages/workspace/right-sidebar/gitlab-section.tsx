import type { ChatGitlabEntity, ChatGitlabEntityType } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { CircleDot, ExternalLink, GitMerge, GitPullRequest } from "lucide-react";
import { listChatGitlabEntities } from "../../../api/chats.js";
import { DenseBadge, type DenseBadgeTone } from "../../../components/ui/dense-badge.js";

export function useChatGitlabEntities(chatId: string): { items: ChatGitlabEntity[]; isLoading: boolean } {
  const query = useQuery({
    queryKey: ["chat-right-sidebar", "gitlab-entities", chatId],
    queryFn: () => listChatGitlabEntities(chatId),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  return { items: query.data?.items ?? [], isLoading: query.isLoading };
}

/**
 * Lists GitLab Issues and Merge Requests bound to the current chat. The
 * server projection includes both explicit follows and the automatic identity
 * route that created a personnel-target chat.
 */
export function GitLabSection({ chatId }: { chatId: string }) {
  const { items, isLoading } = useChatGitlabEntities(chatId);
  if (isLoading || items.length === 0) return null;

  return (
    <section>
      <div className="text-eyebrow" style={{ padding: "var(--sp-2_5) var(--sp-3) var(--sp-1)", color: "var(--fg-4)" }}>
        GitLab <span className="mono">· {items.length}</span>
      </div>
      <div className="flex flex-col" style={{ padding: "0 var(--sp-2) var(--sp-2)", gap: "var(--sp-1_5)" }}>
        {sortGitlabEntitiesByType(items).map((entity) => (
          <GitLabRow key={`${entity.projectPath}:${entity.entityType}:${entity.entityIid}`} entity={entity} />
        ))}
      </div>
    </section>
  );
}

const TYPE_ORDER: Record<ChatGitlabEntityType, number> = {
  pull_request: 0,
  issue: 1,
};

export function sortGitlabEntitiesByType(items: ChatGitlabEntity[]): ChatGitlabEntity[] {
  return [...items].sort((a, b) => TYPE_ORDER[a.entityType] - TYPE_ORDER[b.entityType]);
}

function compactEntityRef(entity: ChatGitlabEntity, hasTitle: boolean): string {
  const project = hasTitle ? (entity.projectPath.split("/").at(-1) ?? entity.projectPath) : entity.projectPath;
  const sigil = entity.entityType === "pull_request" ? "!" : "#";
  return `${project}${sigil}${entity.entityIid}`;
}

function GitLabRow({ entity }: { entity: ChatGitlabEntity }) {
  const Icon =
    entity.entityType === "pull_request" ? (entity.state === "merged" ? GitMerge : GitPullRequest) : CircleDot;
  const hasTitle = Boolean(entity.title && entity.title.length > 0);
  const state = viewForState(entity.state, entity.status);

  return (
    <a
      href={entity.entityUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex items-start transition-colors hover:bg-[var(--bg-hover)]"
      style={{
        gap: "var(--sp-2)",
        padding: "var(--sp-1_5) var(--sp-2)",
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
        {hasTitle ? (
          <div
            className="text-body"
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
        <div
          className="mono text-label flex items-center"
          style={{ gap: "var(--sp-1_5)", color: hasTitle ? "var(--fg-3)" : "var(--fg-2)" }}
        >
          <span
            className="min-w-0"
            style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            title={`${entity.projectPath}:${entity.entityType}:${entity.entityIid}`}
          >
            {compactEntityRef(entity, hasTitle)}
          </span>
          {state ? <DenseBadge tone={state.tone}>{state.label}</DenseBadge> : null}
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

function iconColor(state: string | null): string {
  switch (state) {
    case "merged":
      return "oklch(0.42 0.18 295)";
    case "closed":
      return "var(--fg-3)";
    case "open":
      return "var(--fg-success-strong)";
    default:
      return "var(--fg-3)";
  }
}

function viewForState(
  state: string | null,
  status: ChatGitlabEntity["status"],
): { label: string; tone: DenseBadgeTone } | null {
  if (status === "pending") return { label: "Pending", tone: "outline" };
  switch (state) {
    case "open":
      return { label: "Open", tone: "accent" };
    case "closed":
      return { label: "Closed", tone: "neutral" };
    case "merged":
      return { label: "Merged", tone: "outline" };
    default:
      return null;
  }
}
