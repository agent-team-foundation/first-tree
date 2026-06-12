import type { ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { isNavigableWebHref } from "../../lib/safe-href.js";
import { cn } from "../../lib/utils.js";

type RehypePlugins = ComponentProps<typeof ReactMarkdown>["rehypePlugins"];

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
        "prose-pre:bg-[color:var(--bg-sunken)] prose-pre:text-current prose-pre:border prose-pre:border-[color:var(--border)]",
        "prose-hr:border-[color:var(--border)]",
        "prose-blockquote:border-l-[color:var(--border-strong)] prose-blockquote:text-[color:var(--fg-2)]",
        "prose-th:border-[color:var(--border)] prose-td:border-[color:var(--border)]",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={rehypePlugins}
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
        {children}
      </ReactMarkdown>
    </div>
  );
}
