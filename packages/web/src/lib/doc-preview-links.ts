import {
  normalizeDocLinkPath,
  scanBareDocPathTokens,
  stripDocPathLineSuffix,
} from "@agent-team-foundation/first-tree-hub-shared";

/**
 * Map an `<a href>` from a chat / drawer markdown render to the canonical
 * workspace-relative path used as the doc-snapshot cache key.
 *
 * External-link guards (scheme / scheme-relative / fragment-only) and
 * canonicalisation live in the shared `normalizeDocLinkPath` so runtime,
 * server, and web all reject and canonicalise identically. This wrapper
 * only contributes the href-specific concerns: strip query/hash, accept
 * the `:line[:col]` suffix agents often append, apply the relative-resolve
 * against `currentDocPath`, and require the `.md` suffix.
 */
export function docPreviewPathFromHref(href: string, currentDocPath?: string | null): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;

  const pathPart = trimmed.split(/[?#]/, 1).at(0) ?? "";
  // Accept and discard a `:line[:col]` suffix so a link the chat linkified
  // from `docs/api.md:42` still resolves to `docs/api.md`. Preview-time
  // scrolling to the line is out of scope; the suffix is purely informational
  // for the reader.
  const pathOnly = stripDocPathLineSuffix(pathPart);
  if (!pathOnly.toLowerCase().endsWith(".md")) return null;

  // Relative-resolve against the currently-open doc path BEFORE handing off
  // to the shared canonicaliser so a click on `../api.md` from inside
  // `docs/design.md` resolves to `api.md`.
  let candidate = pathOnly;
  if (currentDocPath && !pathOnly.startsWith("/")) {
    const slash = currentDocPath.lastIndexOf("/");
    const base = slash >= 0 ? currentDocPath.slice(0, slash + 1) : "";
    candidate = `${base}${pathOnly}`;
  }

  return normalizeDocLinkPath(candidate);
}

/**
 * Rewrite plain `.md` path mentions in chat text into inline markdown links
 * so react-markdown renders them as clickable previews.
 *
 * A token is linkified ONLY when its canonical path is present in
 * `snapshotPaths` — the set of `.md` docs the runtime actually embedded as
 * snapshots in this message's `metadata.documentContext`. This is the single
 * invariant that keeps the feature honest:
 *
 *   - No dead / false-positive links. A path the agent merely *mentions*
 *     conversationally (an example like `README.md:12`, a file that doesn't
 *     exist, or a doc that was too large to snapshot) has no snapshot, so it
 *     stays plain text instead of rendering a link that opens an empty preview
 *     or — worse — an unrelated workspace file that happens to share the name.
 *   - Every rendered link is guaranteed to open from the React Query cache
 *     with no server round-trip (load-bearing on the cloud topology).
 *
 * The link target is the CANONICAL (de-suffixed) path, while the visible text
 * keeps the raw token. So `README.md:12` renders `[README.md:12](README.md)`:
 * the user still sees the line number, but the href has no `:` before a `/`,
 * so react-markdown's `defaultUrlTransform` keeps it instead of stripping it
 * to `""` (an empty href made the anchor reload the whole page on click).
 */
export function linkifyMarkdownDocPaths(markdown: string, snapshotPaths: ReadonlySet<string>): string {
  if (snapshotPaths.size === 0) return markdown;
  const matches = scanBareDocPathTokens(markdown);
  if (matches.length === 0) return markdown;

  // Walk matches in order and stitch the new string in O(n). Reversing and
  // splicing would also work but is harder to read and offers no speed-up
  // here since the source string is read sequentially anyway.
  let out = "";
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue;
    // Canonicalise BEFORE wrapping, then require a matching snapshot. Tokens
    // like `.agent/secret.md` / `../outside.md` canonicalise to null; tokens
    // with no embedded snapshot are conversational mentions, not previews.
    const canonical = normalizeDocLinkPath(stripDocPathLineSuffix(match.raw));
    if (!canonical || !snapshotPaths.has(canonical)) continue;
    out += markdown.slice(cursor, match.start);
    out += `[${match.raw}](${canonical})`;
    cursor = match.end;
  }
  out += markdown.slice(cursor);
  return out;
}
