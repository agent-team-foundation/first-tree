import { type GitlabEventCard, gitlabEventCardSchema } from "@first-tree/shared";
import { Gitlab } from "lucide-react";

export const GITLAB_SYSTEM_SENDER_NAME = "GitLab";

export function isGitlabEventCardContent(content: unknown): content is GitlabEventCard {
  return gitlabEventCardSchema.safeParse(content).success;
}

export function isTrustedGitlabDispatcherMessage(msg: {
  source: string | null | undefined;
  format: string;
  content: unknown;
  metadata: unknown;
}): boolean {
  return (
    msg.source === "gitlab" &&
    msg.format === "card" &&
    isGitlabEventCardContent(msg.content) &&
    typeof msg.metadata === "object" &&
    msg.metadata !== null &&
    (msg.metadata as { systemSender?: unknown }).systemSender === "gitlab"
  );
}

export function GitlabSystemAvatar({ size = 20 }: { size?: number }) {
  return (
    <span
      role="img"
      aria-label={GITLAB_SYSTEM_SENDER_NAME}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: "var(--bg-sunken)",
        color: "var(--fg)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Gitlab size={Math.round(size * 0.7)} strokeWidth={2} />
    </span>
  );
}

export function GitlabEventCardMessage({ content }: { content: GitlabEventCard }) {
  return (
    <a
      href={content.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block no-underline"
      style={{
        border: "var(--hairline) solid var(--border)",
        borderRadius: "var(--radius-panel)",
        padding: 12,
        color: "var(--fg)",
      }}
    >
      <div className="flex items-center" style={{ gap: 8 }}>
        <Gitlab size={18} />
        <strong>{content.project}</strong>
        <span className="text-label" style={{ color: "var(--fg-3)" }}>
          {content.entity.type === "pull_request" ? "Merge request" : "Issue"} · {content.kind}
        </span>
      </div>
      <div className="font-semibold" style={{ marginTop: "var(--sp-2)" }}>
        {content.title || content.entity.key}
      </div>
      {content.body ? (
        <div className="text-label" style={{ marginTop: "var(--sp-1)", color: "var(--fg-3)", whiteSpace: "pre-wrap" }}>
          {content.body}
        </div>
      ) : null}
    </a>
  );
}
