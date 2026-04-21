import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { cn } from "../../lib/utils.js";

export type MarkdownProps = {
  children: string;
  className?: string;
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
export function Markdown({ children, className }: MarkdownProps) {
  return (
    <div
      className={cn(
        "prose prose-sm max-w-none",
        "prose-headings:text-current prose-p:text-current prose-li:text-current prose-strong:text-current prose-em:text-current prose-blockquote:text-current",
        "prose-a:text-[color:var(--accent)] prose-a:no-underline hover:prose-a:underline",
        "prose-code:text-current prose-code:bg-[color:var(--bg-sunken)] prose-code:rounded prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.9em] prose-code:before:content-none prose-code:after:content-none",
        "prose-pre:bg-[color:var(--bg-sunken)] prose-pre:text-current prose-pre:border prose-pre:border-[color:var(--border)]",
        "prose-hr:border-[color:var(--border)]",
        "prose-blockquote:border-l-[color:var(--border-strong)] prose-blockquote:text-[color:var(--fg-2)]",
        "prose-th:border-[color:var(--border)] prose-td:border-[color:var(--border)]",
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{children}</ReactMarkdown>
    </div>
  );
}
