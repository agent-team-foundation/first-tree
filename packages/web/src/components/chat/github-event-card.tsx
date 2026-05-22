import { type GithubEventCard, githubEventCardSchema } from "@first-tree/shared";
import type { ReactNode } from "react";

export function isGithubEventCardContent(content: unknown): content is GithubEventCard {
  return githubEventCardSchema.safeParse(content).success;
}

type ChipTone = "accent" | "warn" | "success" | "neutral";

const REASON_LABEL: Record<GithubEventCard["reason"], string> = {
  mentioned: "mentioned",
  review_requested: "review requested",
  assigned: "assigned",
  subscribed: "subscribed",
};

const REASON_TONE: Record<GithubEventCard["reason"], ChipTone> = {
  mentioned: "accent",
  review_requested: "warn",
  assigned: "success",
  subscribed: "neutral",
};

const TONE_STYLE: Record<ChipTone, { background: string; color: string; border: string }> = {
  accent: {
    background: "var(--accent-bg)",
    color: "var(--accent-dim)",
    border: "var(--accent-ring)",
  },
  warn: {
    background: "var(--bg-warn-soft)",
    color: "var(--fg-warn-strong)",
    border: "transparent",
  },
  success: {
    background: "var(--bg-success-soft)",
    color: "var(--fg-success-strong)",
    border: "transparent",
  },
  neutral: {
    background: "var(--bg-sunken)",
    color: "var(--fg-3)",
    border: "var(--border)",
  },
};

function actionPhrase(card: GithubEventCard): string {
  switch (card.reason) {
    case "mentioned":
      return "in";
    case "review_requested":
      return "on";
    case "assigned":
      return "to you on";
    case "subscribed":
      return card.action ? `${card.action.replace(/_/g, " ")} on` : "on";
  }
}

function highlightMention(body: string, mentionedUser: string | undefined): ReactNode {
  if (!mentionedUser) return body;
  const idx = body.indexOf(mentionedUser);
  if (idx < 0) return body;
  return (
    <>
      {body.slice(0, idx)}
      <span className="font-medium" style={{ color: "var(--accent)" }}>
        {body.slice(idx, idx + mentionedUser.length)}
      </span>
      {body.slice(idx + mentionedUser.length)}
    </>
  );
}

const BODY_PREVIEW_MAX = 320;

function truncateBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= BODY_PREVIEW_MAX) return trimmed;
  return `${trimmed.slice(0, BODY_PREVIEW_MAX)}…`;
}

export function GithubEventCardMessage({ content }: { content: GithubEventCard }) {
  const tone = REASON_TONE[content.reason];
  const toneStyle = TONE_STYLE[tone];
  const previewBody = content.body.trim().length > 0 ? truncateBody(content.body) : null;
  const link = content.entity.url ?? content.url;

  return (
    <div className="text-body">
      <span style={{ display: "inline-flex", alignItems: "center", flexWrap: "wrap", columnGap: "var(--sp-1_5)" }}>
        <span
          className="mono text-label"
          style={{
            display: "inline-flex",
            alignItems: "center",
            padding: "var(--sp-px) var(--sp-1_5)",
            borderRadius: "var(--radius-chip)",
            border: `var(--hairline) solid ${toneStyle.border}`,
            background: toneStyle.background,
            color: toneStyle.color,
            whiteSpace: "nowrap",
          }}
        >
          {REASON_LABEL[content.reason]}
        </span>
        <span style={{ color: "var(--fg-3)" }}>{actionPhrase(content)}</span>
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-[color:var(--fg)] no-underline hover:text-[color:var(--accent-dim)] hover:underline"
        >
          <span className="mono" style={{ color: "var(--fg-3)" }}>
            {content.repository}
          </span>
          <span className="mono" style={{ color: "var(--fg-4)" }}>
            {content.entity.key}
          </span>
          {content.title ? <span> — {content.title}</span> : null}
        </a>
        {content.sender ? (
          <span style={{ color: "var(--fg-3)" }}>
            by <span className="mono">{content.sender}</span>
          </span>
        ) : null}
      </span>
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
