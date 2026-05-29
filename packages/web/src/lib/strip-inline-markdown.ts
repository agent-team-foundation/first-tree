/**
 * Reduce a short, single-line markdown preview (an agent's running narration or
 * a tool-arg snippet) to plain text for a chrome-free status rail. The compose
 * status bar shows the agent's `turnText` raw, so inline markdown leaks through
 * as literal syntax — e.g. `` `issue 669` `` renders its backticks, `**done**`
 * its asterisks. The server already collapses whitespace and caps length; this
 * only peels the *inline* emphasis/code/link markers a one-line glance shouldn't
 * carry. It is deliberately conservative — it does NOT try to be a full markdown
 * parser, only to stop the common markers from showing up bare.
 *
 * Pure & exported for unit testing.
 */
export function stripInlineMarkdown(text: string): string {
  return (
    text
      // Links / images: [label](url) or ![alt](url) → keep the human-readable label.
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      // Inline code: `code` → code (drop the backticks, keep the contents).
      .replace(/`([^`]+)`/g, "$1")
      // Bold / italic: **x**, __x__, *x*, _x_ → x. Run the double markers first so
      // the single-marker pass doesn't eat one half of a `**` pair.
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      // Underscore italic only when flanked by non-word chars, so identifiers
      // like `foo_bar_baz` are left intact.
      .replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, "$1$2")
      // Any backticks left over (e.g. an unbalanced one) — never show bare.
      .replace(/`/g, "")
      .trim()
  );
}
