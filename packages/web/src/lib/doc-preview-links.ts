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
 * `[path](path)` so react-markdown renders them as clickable previews. The
 * scan rules are shared with the runtime snapshot scanner (`scanBareDocPathTokens`)
 * — both sides must agree token-for-token, otherwise the web side would
 * render a link whose canonical key has no snapshot in metadata and the
 * click would silently fall back to the legacy server `/me/docs/preview`
 * endpoint that cannot read the agent's local workspace.
 *
 * Each match is also canonicalised through `normalizeDocLinkPath` before it
 * becomes a link — tokens like `.agent/secret.md` or `../outside.md` pass
 * the surface-level regex but `normalizeDocLinkPath` rejects them as
 * hidden / out-of-root, so wrapping them anyway would produce a dead link
 * that `docPreviewPathFromHref` re-rejects on click and the browser then
 * follows as a same-origin nav (404 / navigation away from chat). Filtering
 * here keeps the invariant "every wrapped token has a matching snapshot or
 * is at least resolvable inside the workspace".
 */
export function linkifyMarkdownDocPaths(markdown: string): string {
  const matches = scanBareDocPathTokens(markdown);
  if (matches.length === 0) return markdown;

  // Walk matches in order and stitch the new string in O(n). Reversing and
  // splicing would also work but is harder to read and offers no speed-up
  // here since the source string is read sequentially anyway.
  let out = "";
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue;
    // Canonicalise BEFORE wrapping. If the token would not resolve to a
    // workspace-safe canonical path we leave the original text alone —
    // rendering an anchor whose onClick declines to intercept produces a
    // same-origin navigation, which is far worse UX than plain text.
    const canonical = normalizeDocLinkPath(stripDocPathLineSuffix(match.raw));
    if (!canonical) continue;
    out += markdown.slice(cursor, match.start);
    out += `[${match.raw}](${match.raw})`;
    cursor = match.end;
  }
  out += markdown.slice(cursor);
  return out;
}
