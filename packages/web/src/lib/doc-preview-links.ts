import {
  buildWorkspaceDocKey,
  type DocSnapshotFailReason,
  docSnapshotFailReasonSchema,
  normalizeDocLinkPath,
  scanBareDocPathTokens,
  stripDocPathLineSuffix,
} from "@first-tree/shared";

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
 *
 * Cross-agent (`chatId` provided): a snapshot of a file in ANOTHER agent's
 * workspace is keyed globally as `<ownerSlug>/<chatId>/<rel>`, and the runtime
 * rewrites the visible mention to the short `<ownerSlug>/<rel>` form. So when
 * a bare canonical token isn't itself a snapshot key, we also try expanding it
 * with the current chat id (`<firstSeg>/<chatId>/<rest>`) and link to that
 * global key if it matches. Self/legacy bare keys still match directly and
 * win (tried first), so self previews are unchanged.
 */
export function linkifyMarkdownDocPaths(markdown: string, snapshotPaths: ReadonlySet<string>, chatId?: string): string {
  if (snapshotPaths.size === 0) return markdown;
  const matches = scanBareDocPathTokens(markdown);
  if (matches.length === 0) return markdown;

  // Walk matches in order and stitch the new string in O(n). Reversing and
  // splicing would also work but is harder to read and offers no speed-up
  // here since the source string is read sequentially anyway.
  let out = "";
  let cursor = 0;
  for (const match of matches) {
    // The cursor jumps past any code-span widening from a previous match, so
    // a same-span sibling token here would land below `cursor` and skip — the
    // multi-path-in-one-code-span degenerate case (first wins, rest dropped).
    if (match.start < cursor) continue;
    // Canonicalise BEFORE wrapping, then require a matching snapshot. Tokens
    // like `.agent/secret.md` / `../outside.md` canonicalise to null; tokens
    // with no embedded snapshot are conversational mentions, not previews.
    const canonical = normalizeDocLinkPath(stripDocPathLineSuffix(match.raw));
    if (!canonical) continue;
    const target = resolveSnapshotKey(canonical, snapshotPaths, chatId);
    if (!target) continue;
    if (match.enclosingCodeSpan && match.enclosingCodeSpan.start >= cursor) {
      // Code-span-wrapped path in a legacy (pre-runtime-rewrite) message:
      // widen the linkification to the whole `` `…` `` span and slice it
      // verbatim into the link text. Same shape as the runtime emits for
      // fresh messages, so render output is consistent across vintages.
      out += markdown.slice(cursor, match.enclosingCodeSpan.start);
      const visibleText = markdown.slice(match.enclosingCodeSpan.start, match.enclosingCodeSpan.end);
      out += `[${visibleText}](${target})`;
      cursor = match.enclosingCodeSpan.end;
    } else {
      out += markdown.slice(cursor, match.start);
      out += `[${match.raw}](${target})`;
      cursor = match.end;
    }
  }
  out += markdown.slice(cursor);
  return out;
}

/**
 * Map a canonical bare token to the snapshot key it should link to, or null if
 * none. Self/legacy bare keys are tried first (so self previews are unchanged);
 * otherwise, with a chat id, the token is treated as the short cross form
 * `<ownerSlug>/<rest>` and expanded to the global `<ownerSlug>/<chatId>/<rest>`
 * key.
 */
function resolveSnapshotKey(canonical: string, snapshotPaths: ReadonlySet<string>, chatId?: string): string | null {
  if (snapshotPaths.has(canonical)) return canonical;
  if (!chatId) return null;
  const slash = canonical.indexOf("/");
  if (slash <= 0) return null;
  const ownerSlug = canonical.slice(0, slash);
  const rest = canonical.slice(slash + 1);
  const global = buildWorkspaceDocKey(ownerSlug, chatId, rest);
  return global && snapshotPaths.has(global) ? global : null;
}

/**
 * Fragment-style href used to encode a failed-mention reason inside markdown
 * link syntax. `#doc-failed?reason=<reason>` passes through react-markdown's
 * `defaultUrlTransform` unchanged (no colon → no scheme check) and the
 * chat-view's `a` component override detects the prefix to render a disabled
 * inert chip in place of an `<a>`. Kept as an internal magic string so we can
 * change the format later without churning consumers.
 */
const FAILED_DOC_HREF_PREFIX = "#doc-failed";

export function buildFailedDocHref(reason: DocSnapshotFailReason): string {
  return `${FAILED_DOC_HREF_PREFIX}?reason=${encodeURIComponent(reason)}`;
}

/**
 * Parse a magic failed-mention href back into the reason. Returns null when
 * the href isn't ours or when the embedded reason isn't a valid enum value
 * (defensive: a malformed reason renders as plain link, never a crash).
 */
export function parseFailedDocHref(href: string): DocSnapshotFailReason | null {
  if (!href.startsWith(FAILED_DOC_HREF_PREFIX)) return null;
  const queryIdx = href.indexOf("?");
  if (queryIdx === -1) return null;
  const params = new URLSearchParams(href.slice(queryIdx + 1));
  const raw = params.get("reason");
  if (!raw) return null;
  const parsed = docSnapshotFailReasonSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Wrap bare `.md` mentions that the runtime marked as snapshot failures into
 * the inert-chip placeholder link form. Same scanner as `linkifyMarkdownDocPaths`
 * so positioning + code-span widening are identical to the success path; the
 * difference is only the link's href — a magic `#doc-failed?reason=…` string
 * that the chat-view's `a` override picks up to render a disabled chip.
 *
 * `failedReasonsByRaw` maps the agent's WRITTEN path (suffix-stripped — the
 * wire stores `raw` without `:line[:col]`) to the bucketed reason. The scanner
 * gives back `match.raw` WITH the line suffix when present, so we strip it
 * before lookup.
 *
 * Returning the input unchanged when there is no failure metadata or no
 * scanner match keeps this a cheap no-op in the common case.
 */
export function wrapFailedDocMentions(
  markdown: string,
  failedReasonsByRaw: ReadonlyMap<string, DocSnapshotFailReason>,
): string {
  if (failedReasonsByRaw.size === 0) return markdown;
  const matches = scanBareDocPathTokens(markdown);
  if (matches.length === 0) return markdown;

  let out = "";
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue;
    const lookupKey = stripDocPathLineSuffix(match.raw);
    const reason = failedReasonsByRaw.get(lookupKey);
    if (!reason) continue;
    const href = buildFailedDocHref(reason);
    if (match.enclosingCodeSpan && match.enclosingCodeSpan.start >= cursor) {
      // Code-span-wrapped failure: widen to the whole `` `…` `` span so the
      // disabled chip carries the mono-spaced visual the agent intended.
      out += markdown.slice(cursor, match.enclosingCodeSpan.start);
      const visibleText = markdown.slice(match.enclosingCodeSpan.start, match.enclosingCodeSpan.end);
      out += `[${visibleText}](${href})`;
      cursor = match.enclosingCodeSpan.end;
    } else {
      out += markdown.slice(cursor, match.start);
      out += `[${match.raw}](${href})`;
      cursor = match.end;
    }
  }
  out += markdown.slice(cursor);
  return out;
}
