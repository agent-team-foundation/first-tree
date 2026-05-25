import { type GithubEntityType, type GithubEventCard, githubEventCardSchema } from "@first-tree/shared";
import { Github } from "lucide-react";
import type { ReactNode } from "react";

export function isGithubEventCardContent(content: unknown): content is GithubEventCard {
  return githubEventCardSchema.safeParse(content).success;
}

/**
 * The GitHub-dispatcher delivery path writes `systemSender: "github"` into
 * `message.metadata` so the chat view can render the row with a synthetic
 * "GitHub" sender (icon + name) instead of the human-agent row whose id we
 * still keep in `senderId` for routing / read-receipts. Helpers live here
 * next to the card so the metadata flag and the visual override stay in
 * lockstep.
 */
export const GITHUB_SYSTEM_SENDER_NAME = "GitHub";

export function isGithubSystemSenderMetadata(metadata: unknown): boolean {
  if (typeof metadata !== "object" || metadata === null) return false;
  return (metadata as { systemSender?: unknown }).systemSender === "github";
}

export function GithubSystemAvatar({ size = 20 }: { size?: number }) {
  const dim = `${size}px`;
  return (
    <span
      role="img"
      aria-label={GITHUB_SYSTEM_SENDER_NAME}
      style={{
        width: dim,
        height: dim,
        borderRadius: "50%",
        background: "var(--fg)",
        color: "var(--bg)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        lineHeight: 1,
      }}
    >
      <Github size={Math.round(size * 0.65)} strokeWidth={2} />
    </span>
  );
}

const ENTITY_TAG_LABEL: Record<GithubEntityType, string> = {
  issue: "Issue",
  pull_request: "PR",
  discussion: "Discussion",
  commit: "Commit",
};

/**
 * `entity.key` arrives as `owner/repo#N` or `owner/repo@<sha>`. Strip the
 * repo prefix so the chip renders the short `#N` / `@<sha>` form. Falls
 * back defensively to the segment after the last `/` if the prefix does
 * not match (older messages, schema drift).
 */
function shortEntityNumber(key: string, repository: string): string {
  if (repository && (key.startsWith(`${repository}#`) || key.startsWith(`${repository}@`))) {
    return key.slice(repository.length);
  }
  const lastSlash = key.lastIndexOf("/");
  return lastSlash >= 0 ? key.slice(lastSlash + 1) : key;
}

function shortRepoName(repository: string): string {
  const lastSlash = repository.lastIndexOf("/");
  return lastSlash >= 0 ? repository.slice(lastSlash + 1) : repository;
}

function subscribedVerb(kind: GithubEventCard["kind"]): string {
  switch (kind) {
    case "opened":
      return "opened this";
    case "closed":
      return "closed this";
    case "merged":
      return "merged this";
    case "reopened":
      return "reopened this";
    case "commented":
      return "commented";
    case "reviewed":
      return "reviewed";
    case "review_comment":
      return "left a review comment";
    case "review_requested":
      return "requested a review";
    case "synchronized":
      return "pushed new commits";
    case "commit_commented":
      return "commented on a commit";
    case "assigned":
      return "updated assignees";
    case "edited":
      return "edited this";
    case "other":
      return "updated this";
  }
}

function actionVerb(content: GithubEventCard): string {
  switch (content.reason) {
    case "mentioned":
      return "mentioned you";
    case "review_requested":
      return "requested your review";
    case "assigned":
      return "assigned this to you";
    case "subscribed":
      return subscribedVerb(content.kind);
  }
}

function highlightMention(body: string, mentionedUser: string | undefined): ReactNode {
  if (!mentionedUser) return body;
  // github-delivery writes the bare login (no `@`); GitHub bodies usually
  // carry the `@` prefix. Try `@login` first, fall back to bare login so
  // we still highlight if upstream ever changes the convention.
  const candidates = [`@${mentionedUser}`, mentionedUser];
  for (const needle of candidates) {
    const idx = body.indexOf(needle);
    if (idx < 0) continue;
    return (
      <>
        {body.slice(0, idx)}
        <span className="font-medium" style={{ color: "var(--accent)" }}>
          {body.slice(idx, idx + needle.length)}
        </span>
        {body.slice(idx + needle.length)}
      </>
    );
  }
  return body;
}

const BODY_PREVIEW_MAX = 320;

function truncateBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= BODY_PREVIEW_MAX) return trimmed;
  return `${trimmed.slice(0, BODY_PREVIEW_MAX)}…`;
}

export function GithubEventCardMessage({ content }: { content: GithubEventCard }) {
  // schema types both urls as `z.string()` (no `.url()` / `.min(1)`), so an
  // empty string is a possible wire value; `??` would only catch `null` and
  // would render `<a href="">` as a dead link.
  const link = content.entity.url || content.url || null;
  const previewBody = content.body.trim().length > 0 ? truncateBody(content.body) : null;
  const tagLabel = ENTITY_TAG_LABEL[content.entity.type];
  const entityNumber = shortEntityNumber(content.entity.key, content.repository);
  const repoShort = shortRepoName(content.repository);
  const verb = actionVerb(content);

  const entityChip = (
    <span
      className="mono text-label"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--sp-1)",
        padding: "var(--sp-px) var(--sp-1_5)",
        borderRadius: "var(--radius-chip)",
        background: "var(--bg-sunken)",
        border: "var(--hairline) solid var(--border)",
        whiteSpace: "nowrap",
        lineHeight: 1.4,
      }}
    >
      <span className="font-semibold" style={{ color: "var(--accent-dim)" }}>
        {tagLabel}
      </span>
      <span style={{ color: "var(--fg-3)" }}>{entityNumber}</span>
    </span>
  );

  return (
    <div className="text-body">
      {/* L1 — entity row: clickable chip + title + faded repo */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          flexWrap: "wrap",
          columnGap: "var(--sp-1_5)",
          rowGap: "var(--sp-px)",
        }}
      >
        {link ? (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="no-underline hover:opacity-80"
            style={{ textDecoration: "none" }}
          >
            {entityChip}
          </a>
        ) : (
          entityChip
        )}
        {content.title ? (
          <span className="font-medium" style={{ color: "var(--fg)", minWidth: 0, flex: "1 1 auto" }}>
            {content.title}
          </span>
        ) : null}
        <span className="mono text-caption" style={{ color: "var(--fg-4)", marginLeft: "auto", flexShrink: 0 }}>
          {repoShort}
        </span>
      </div>

      {/* L2 — action sentence: @actor verb */}
      <div className="text-caption" style={{ color: "var(--fg-3)", marginTop: "var(--sp-1)" }}>
        <span className="mono">@{content.sender}</span> {verb}
      </div>

      {/* L3 — quoted body preview */}
      {previewBody ? (
        <div
          className="text-body"
          style={{
            marginTop: "var(--sp-1)",
            color: "var(--fg-3)",
            borderLeft: "var(--hairline-bold) solid var(--border)",
            paddingLeft: "var(--sp-2)",
            whiteSpace: "pre-wrap",
            display: "-webkit-box",
            WebkitLineClamp: 3,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {highlightMention(previewBody, content.mentionedUser)}
        </div>
      ) : null}
    </div>
  );
}
