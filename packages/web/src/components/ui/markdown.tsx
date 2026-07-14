import type { ComponentProps } from "react";
import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { isNavigableWebHref } from "../../lib/safe-href.js";
import { cn } from "../../lib/utils.js";

type RehypePlugins = ComponentProps<typeof ReactMarkdown>["rehypePlugins"];

type QuoteLineKind = "standard" | "pipe";

/**
 * react-markdown's `defaultUrlTransform` sanitizes hrefs and STRIPS any
 * unrecognized scheme to an empty string before our `a` component override
 * runs — so a doc-preview `attachment:<uuid>` link (and the `#doc-failed`
 * failure-chip fragment) would otherwise arrive at the override as `href=""`
 * and render as dead text. Preserve exactly our two internal href shapes and
 * delegate everything else to the default transform, so normal external links
 * keep their full XSS-safety scrubbing (no weakening for `javascript:` etc.).
 */
function previewSafeUrlTransform(url: string): string {
  if (url.startsWith("attachment:") || url.startsWith("#doc-failed")) return url;
  return defaultUrlTransform(url);
}

function quoteLineKind(line: string): QuoteLineKind | null {
  if (/^ {0,3}>/.test(line)) return "standard";

  const pipeMatch = /^ {0,3}\|(.*)$/.exec(line);
  if (!pipeMatch) return null;

  const markerTail = pipeMatch[1] ?? "";
  if (markerTail && !/^\s/.test(markerTail)) return null;

  const content = markerTail.trimEnd();
  return content.includes("|") ? null : "pipe";
}

function normalizePipeQuoteLine(line: string): string {
  return line.replace(/^( {0,3})\|[ \t]?/, "$1> ");
}

function isPipeTableRow(line: string): boolean {
  return /^ {0,3}\|/.test(line);
}

function isPipeTableDelimiter(line: string | undefined): boolean {
  if (!line || !isPipeTableRow(line)) return false;

  const trimmed = line.trim();
  const cells = trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function startsPipeTable(lines: string[], index: number): boolean {
  return isPipeTableRow(lines[index] ?? "") && isPipeTableDelimiter(lines[index + 1]);
}

function isQuoteContinuationLine(lines: string[], index: number): boolean {
  if (startsPipeTable(lines, index)) return false;
  return quoteLineKind(lines[index] ?? "") !== null;
}

function fenceMarker(line: string): { char: "`" | "~"; length: number } | null {
  const match = /^(?: {0,3})(`{3,}|~{3,})/.exec(line);
  if (!match) return null;
  const marker = match[1] ?? "";
  const char = marker[0] as "`" | "~";
  return { char, length: marker.length };
}

function closesFence(line: string, fence: { char: "`" | "~"; length: number }): boolean {
  const match = /^(?: {0,3})(`{3,}|~{3,})\s*$/.exec(line);
  return Boolean(match?.[1]?.startsWith(fence.char) && match[1].length >= fence.length);
}

function normalizeQuoteContinuations(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const normalized: string[] = [];
  let openFence: { char: "`" | "~"; length: number } | null = null;
  let insidePipeTable = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (openFence) {
      normalized.push(line);
      if (closesFence(line, openFence)) openFence = null;
      continue;
    }

    if (insidePipeTable) {
      if (isPipeTableRow(line)) {
        normalized.push(line);
        continue;
      }
      insidePipeTable = false;
    }

    if (startsPipeTable(lines, index)) {
      insidePipeTable = true;
      normalized.push(line);
      continue;
    }

    const kind = quoteLineKind(line);
    const normalizedLine = kind === "pipe" ? normalizePipeQuoteLine(line) : line;
    normalized.push(normalizedLine);

    if (kind) {
      const nextLine = lines[index + 1];
      if (nextLine?.trim() && !isQuoteContinuationLine(lines, index + 1)) {
        normalized.push("");
      }
      continue;
    }

    openFence = fenceMarker(line);
  }

  return normalized.join("\n");
}

export type MarkdownProps = {
  children: string;
  className?: string;
  components?: Components;
  rehypePlugins?: RehypePlugins;
};

/**
 * Renders a markdown string with GFM (tables, task lists, strikethrough,
 * autolinks) and treats single newlines as hard line breaks, matching the
 * way people type messages in a chat box.
 *
 * Color inherits from the surrounding context via `prose-inherit`, so the
 * same component fits both the dark workspace chat and the light agent
 * detail page without a theme switch.
 */
export function Markdown({ children, className, components, rehypePlugins }: MarkdownProps) {
  const normalizedChildren = normalizeQuoteContinuations(children);

  return (
    <div
      className={cn(
        // `break-words` lets unbreakable runs (bare URLs with embedded
        // tokens, long file paths) wrap instead of widening the chat
        // column — an overflowing message otherwise puts a horizontal
        // scrollbar on the whole timeline, because the scroll container's
        // `overflow-y: auto` makes the browser compute `overflow-x` as
        // `auto` too.
        "prose prose-sm max-w-none break-words leading-[1.55] text-[color:inherit]",
        "prose-headings:text-current prose-p:text-current prose-li:text-current prose-strong:text-current prose-em:text-current prose-blockquote:text-current",
        "prose-p:my-2 prose-headings:mt-3 prose-headings:mb-1.5 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-pre:my-2 prose-blockquote:my-2 prose-hr:my-3",
        "prose-a:text-[color:var(--primary)] prose-a:no-underline hover:prose-a:underline",
        "prose-code:text-current prose-code:bg-[color:var(--bg-sunken)] prose-code:rounded prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.9em] prose-code:before:content-none prose-code:after:content-none",
        "prose-pre:max-w-full prose-pre:overflow-x-auto prose-pre:bg-[color:var(--bg-sunken)] prose-pre:text-current prose-pre:border prose-pre:border-[color:var(--border)]",
        "prose-hr:border-[color:var(--border)]",
        "prose-blockquote:border-l-[color:var(--border-strong)] prose-blockquote:text-[color:var(--fg-2)]",
        "prose-th:border-[color:var(--border)] prose-td:border-[color:var(--border)]",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={rehypePlugins}
        urlTransform={previewSafeUrlTransform}
        components={{
          a: ({ node, href, children, ...props }) => {
            void node;
            // issue 831: never render a local filesystem path / unknown-scheme href
            // as a live anchor — it has no route on the cloud origin and 404s
            // when clicked. Show the link text instead of a dead link.
            if (!isNavigableWebHref(href)) {
              return <>{children}</>;
            }
            return (
              <a {...props} href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            );
          },
          ...components,
        }}
      >
        {normalizedChildren}
      </ReactMarkdown>
    </div>
  );
}
