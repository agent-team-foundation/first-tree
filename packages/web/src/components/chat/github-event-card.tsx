import {
  contextReviewManagedMessageMetadataSchema,
  type GithubEntityType,
  type GithubEventCard,
  githubEventCardSchema,
} from "@first-tree/shared";
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

/**
 * Conjunctive trust gate for re-attributing a row to the synthetic
 * "GitHub" sender. Metadata alone is not sufficient — `sendMessageSchema`
 * accepts arbitrary `metadata`, so a malicious agent could otherwise post
 * a normal text message with `{ systemSender: "github" }` and have the UI
 * render it as if from GitHub (sender-impersonation / phishing surface
 * flagged in code review). The ordinary dispatcher path uniquely sets a
 * valid GitHub card plus the metadata marker. Managed Context Review wakes
 * are server-authored Markdown, so they instead require the complete
 * versioned managed-event metadata envelope. The message service reserves
 * `systemSender` and `contextReview*` keys, keeping both branches unavailable
 * to regular agent sends.
 */
type TrustedGithubMessageShape = {
  source: string | null | undefined;
  format: string;
  content: unknown;
  metadata: unknown;
};

export function isTrustedGithubDispatcherMessage(msg: TrustedGithubMessageShape): boolean {
  if (msg.source !== "github") return false;
  if (msg.format === "card") {
    return isGithubEventCardContent(msg.content) && isGithubSystemSenderMetadata(msg.metadata);
  }
  return (
    msg.format === "markdown" &&
    typeof msg.content === "string" &&
    contextReviewManagedMessageMetadataSchema.safeParse(msg.metadata).success
  );
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
 * `entity.key` arrives canonically as `owner/repo#N` (issue / PR /
 * discussion) or `owner/repo@<sha>` (commit). Older persisted discussion
 * cards may still carry `owner/repo#discussion-N`; collapse that legacy
 * infix so the chip and the surface-title-strip both reference the same
 * `#N` form that appears in the server-rendered title.
 * Falls back defensively to the segment after the last `/` if neither
 * prefix shape matches (older messages, schema drift).
 */
export function shortEntityNumber(key: string, repository: string): string {
  let tail: string;
  if (repository && (key.startsWith(`${repository}#`) || key.startsWith(`${repository}@`))) {
    tail = key.slice(repository.length);
  } else {
    const lastSlash = key.lastIndexOf("/");
    tail = lastSlash >= 0 ? key.slice(lastSlash + 1) : key;
  }
  const DISC_PREFIX = "#discussion-";
  return tail.startsWith(DISC_PREFIX) ? `#${tail.slice(DISC_PREFIX.length)}` : tail;
}

function shortRepoName(repository: string): string {
  const lastSlash = repository.lastIndexOf("/");
  return lastSlash >= 0 ? repository.slice(lastSlash + 1) : repository;
}

/**
 * Server-side `entitySurfaceTitle` (services/github-normalize.ts) wraps the
 * raw entity title as `"PR #N: <title>"` / `"Issue #N: <title>"` /
 * `"Discussion #N: <title>"` / `"Commit: <title>"`. The L1 chip already
 * renders that prefix as a colored badge, so leaving it inside the title
 * string duplicates information. Strip the exact prefix we expect from the
 * server formatter; if the title doesn't match (older messages, schema
 * drift), return as-is so we never silently drop the title.
 */
export function stripEntityPrefix(title: string, entityType: GithubEntityType, entityNumber: string): string {
  const prefix = ENTITY_TAG_LABEL[entityType];
  if (entityType === "commit") {
    if (title.startsWith(`${prefix}: `)) return title.slice(prefix.length + 2);
    if (title === prefix) return "";
    return title;
  }
  const head = `${prefix} ${entityNumber}`;
  if (title.startsWith(`${head}: `)) return title.slice(head.length + 2);
  if (title === head) return "";
  return title;
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
      // Passive voice on the subscribed track avoids a semantic clash
      // with `actionVerb`'s "assigned this to you" (reason=assigned),
      // which addresses the recipient directly. The subscribed track is
      // an audience announcement, not a directed assignment, so a
      // bystander reads "was assigned" without inferring it's pointed at
      // them.
      return "was assigned";
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

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightMention(body: string, mentionedUser: string | undefined): ReactNode {
  if (!mentionedUser) return body;
  // github-delivery writes the bare login (no `@`); GitHub bodies usually
  // carry the `@` prefix. Try `@login` first (literal `indexOf`, since `@`
  // is not a word char so a partial match like `@melon` for login `me` is
  // impossible). Fall back to a word-boundary regex so a bare-login
  // search for `me` doesn't highlight the `me` inside `melon` — the
  // fallback fires only when upstream stops including `@` in the body,
  // so its match window is rarer and worth the stricter check.
  const prefixed = `@${mentionedUser}`;
  const prefixedIdx = body.indexOf(prefixed);
  if (prefixedIdx >= 0) {
    return (
      <>
        {body.slice(0, prefixedIdx)}
        <span className="font-medium" style={{ color: "var(--brand)" }}>
          {body.slice(prefixedIdx, prefixedIdx + prefixed.length)}
        </span>
        {body.slice(prefixedIdx + prefixed.length)}
      </>
    );
  }
  const bareMatch = new RegExp(`\\b${escapeRegex(mentionedUser)}\\b`).exec(body);
  if (bareMatch) {
    const start = bareMatch.index;
    const end = start + bareMatch[0].length;
    return (
      <>
        {body.slice(0, start)}
        <span className="font-medium" style={{ color: "var(--brand)" }}>
          {body.slice(start, end)}
        </span>
        {body.slice(end)}
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
  const titleText = stripEntityPrefix(content.title, content.entity.type, entityNumber);

  const entityChip = (
    <span
      data-github-card-entity
      className="mono text-label"
      style={{
        display: "inline-flex",
        alignItems: "center",
        minWidth: 0,
        maxWidth: "100%",
        gap: "var(--sp-1)",
        padding: "var(--sp-px) var(--sp-1_5)",
        borderRadius: "var(--radius-chip)",
        background: "var(--bg-sunken)",
        border: "var(--hairline) solid var(--border)",
        whiteSpace: "nowrap",
        lineHeight: 1.4,
      }}
    >
      <span className="font-semibold" style={{ color: "var(--primary)", flexShrink: 0 }}>
        {tagLabel}
      </span>
      <span
        data-github-card-entity-number
        title={entityNumber}
        style={{ color: "var(--fg-3)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}
      >
        {entityNumber}
      </span>
    </span>
  );

  return (
    <div className="text-body">
      {/* L1 — entity row: syntax-highlight chip + clickable title + faded repo */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          flexWrap: "wrap",
          columnGap: "var(--sp-1_5)",
          rowGap: "var(--sp-px)",
        }}
      >
        {entityChip}
        {titleText ? (
          link ? (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              data-github-card-title
              className="font-medium no-underline hover:underline"
              style={{
                color: "var(--fg)",
                minWidth: 0,
                flex: "1 1 auto",
                overflowWrap: "anywhere",
                textDecoration: "none",
              }}
            >
              {titleText}
            </a>
          ) : (
            <span
              data-github-card-title
              className="font-medium"
              style={{ color: "var(--fg)", minWidth: 0, flex: "1 1 auto", overflowWrap: "anywhere" }}
            >
              {titleText}
            </span>
          )
        ) : null}
        <span
          data-github-card-repository
          className="mono text-caption"
          style={{
            color: "var(--fg-4)",
            marginLeft: "auto",
            minWidth: 0,
            maxWidth: "100%",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {repoShort}
        </span>
      </div>

      {/* L2 — action sentence: @actor verb */}
      <div
        className="text-caption"
        style={{ color: "var(--fg-3)", marginTop: "var(--sp-1)", overflowWrap: "anywhere" }}
      >
        <span className="mono">@{content.sender}</span> {verb}
      </div>

      {/* L3 — quoted body preview */}
      {previewBody ? (
        <div
          data-github-card-body
          className="text-body"
          style={{
            marginTop: "var(--sp-1)",
            color: "var(--fg-3)",
            borderLeft: "var(--hairline-bold) solid var(--border)",
            paddingLeft: "var(--sp-2)",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
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
