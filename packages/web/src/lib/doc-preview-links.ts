import {
  type DocSnapshotFailReason,
  docSnapshotFailReasonSchema,
  scanBareDocPathTokens,
  stripDocPathLineSuffix,
} from "@first-tree/shared";

/**
 * URL scheme the runtime rewrites a captured doc mention into:
 * `[display](attachment:<attachmentId>)`. The chat-view / drawer `a` override
 * parses it back into the attachment id and opens the doc-preview drawer, which
 * fetches the bytes from `GET /attachments/:id`. Kept as an internal magic
 * string so the wire format has a single definition.
 */
const ATTACHMENT_HREF_SCHEME = "attachment:";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Map an `<a href>` to the attachment id of the doc it previews, or null when
 * the href is not an `attachment:<uuid>` link. Strips any `?query`/`#fragment`
 * defensively; requires a uuid-shaped id so a malformed href can never address
 * a non-attachment route.
 */
export function attachmentIdFromHref(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed.toLowerCase().startsWith(ATTACHMENT_HREF_SCHEME)) return null;
  const rest = trimmed.slice(ATTACHMENT_HREF_SCHEME.length);
  const id = rest.split(/[?#]/, 1).at(0) ?? "";
  return UUID_RE.test(id) ? id : null;
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
 * Wrap bare `.md` mentions that the runtime marked as capture failures into the
 * inert-chip placeholder link form. The runtime no longer linkifies successful
 * captures on the web side (it rewrites them to explicit `attachment:` links
 * itself), so this is the only scanner-driven rewrite left.
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
