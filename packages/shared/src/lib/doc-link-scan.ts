/**
 * Shared scanner for plain markdown document-path tokens inside chat text.
 *
 * Runtime (client) calls this to know which `.md` paths to read off disk and
 * embed as snapshots in `metadata.documentContext`. Web calls the same scanner
 * to know which tokens to wrap in `[path](path)` so react-markdown renders
 * them as clickable links. Sharing one scanner is what guarantees that every
 * link the user sees in the UI has a matching snapshot in metadata — the
 * cache-key on both sides is the canonical path the scanner reports here.
 *
 * Skipped constructs (must stay aligned with markdown rules so we don't
 * rewrite something the renderer already treats specially):
 *   - inline markdown links `[text](path.md)` (the runtime scans those
 *     separately via `scanInlineMarkdownLinks`; this scanner intentionally
 *     does not double-handle them)
 *   - fenced code blocks (``` ``` ``` ``` / `~~~`)
 *   - indented code blocks (4+ spaces or leading tab)
 *   - HTML tag bodies `<...>` (so href / src attribute values aren't
 *     re-linkified)
 *   - reference-link definitions `[ref]: target`
 *   - domain-shaped tokens like `example.com/readme.md` — these are URLs the
 *     user almost certainly meant as external links, not workspace paths.
 *
 * Inline code spans (`` `…` ``, `` ``…`` ``, …) are NOT a hard skip: agents
 * habitually wrap workspace paths in single backticks for mono-spaced visual
 * intent, so a token found inside a single-line code span is still reported
 * with an `enclosingCodeSpan` annotation. The downstream rewrite uses that to
 * widen its replacement span — turning `` `docs/foo.md` `` into the
 * commonmark-legal `` [`docs/foo.md`](docs/foo.md) ``, which renders as a
 * code-styled clickable link instead of dead inline code. Fenced code blocks
 * are deliberately left as a hard skip (typical content is directory dumps,
 * error logs, third-party path examples — false-positive cost is high).
 *
 * The function returns matches WITH offsets so callers that need to rewrite
 * the source string (web's `linkifyMarkdownDocPaths`) can do so without
 * re-running the same regex.
 */

/**
 * v1 limitation — the path-segment character class is intentionally ASCII
 * only. Unicode filenames and Windows backslash-separated paths are NOT
 * linkified. Workspaces in practice use POSIX-style ASCII paths. The regex
 * does accept a leading "/", so absolute tokens are scanned; the runtime
 * (`buildMessageDocumentSnapshots`) resolves an absolute path that lands
 * inside the workspace root and rewrites it to its canonical relative form,
 * while `normalizeDocLinkPath` strips a leading "/" and treats the rest as
 * root-relative. Loosening the character class later is straightforward but
 * requires re-validating that we don't accidentally absorb adjacent
 * punctuation as part of a "filename".
 */
const BARE_PATH_RE =
  /(^|[\s([{"'`])(?<path>(?:\.{1,2}\/|\/)?(?:[A-Za-z0-9_.~+@%-]+\/)*[A-Za-z0-9_.~+@%-]+\.md(?::\d+(?::\d+)?)?)(?=$|[\s)\]}"',.;!?`])/g;

const INLINE_MARKDOWN_LINK_RE = /\[(?:[^\]\\\n]|\\.)*\]\([^)\n]*\)/g;
const REFERENCE_LINK_DEFINITION_RE = /^\s*\[[^\]\n]+\]:\s*\S+/;
const HTML_TAG_RE = /<\/?[A-Za-z][^>\n]*>/g;
const FENCE_MARKER_RE = /^(?: {0,3})(?<marker>`{3,}|~{3,})/;
const INDENT_CODE_RE = /^(?: {4}|\t)/;
const DOMAIN_LIKE_PREFIX_RE = /^[a-z][a-z0-9.-]*\.[a-z]{2,}\//i;

type FenceState = {
  marker: "`" | "~";
  length: number;
};

export type BarePathMatch = {
  /** The raw token as it appears in the text, including any `:line[:col]`. */
  raw: string;
  /** Byte offset (UTF-16 code-unit offset) of `raw` inside the input string. */
  start: number;
  /** Byte offset of the character just after `raw`. */
  end: number;
  /**
   * Outer span (opening tick → closing tick, inclusive) of the inline code
   * wrapper around this token, when the token sits inside one. Set only for
   * single-line code spans (any tick count); fenced multi-line blocks remain
   * a hard skip and produce no match. The rewrite pass widens its replacement
   * to this span so the whole code-styled chunk becomes a single clickable
   * code-styled link.
   */
  enclosingCodeSpan?: { start: number; end: number };
};

/**
 * Scan `text` for plain `.md` path tokens that are NOT already wrapped in a
 * markdown link, code span, HTML tag, or fenced/indented code block.
 *
 * The returned tokens still need to be passed through
 * `normalizeDocLinkPath(stripLineSuffix(raw))` before they are treated as
 * canonical workspace paths.
 */
export function scanBareDocPathTokens(text: string): BarePathMatch[] {
  const out: BarePathMatch[] = [];
  // Split on newlines while preserving them in indices via a running offset.
  const lines = text.split(/(\r?\n)/);
  let fence: FenceState | null = null;
  let absoluteOffset = 0;

  for (const line of lines) {
    if (line === "\n" || line === "\r\n") {
      absoluteOffset += line.length;
      continue;
    }
    if (fence) {
      if (isClosingFence(line, fence)) {
        fence = null;
      }
      absoluteOffset += line.length;
      continue;
    }
    const openingFence = parseOpeningFence(line);
    if (openingFence) {
      fence = openingFence;
      absoluteOffset += line.length;
      continue;
    }
    if (INDENT_CODE_RE.test(line) || REFERENCE_LINK_DEFINITION_RE.test(line)) {
      absoluteOffset += line.length;
      continue;
    }

    const hardSkipRanges = findHardSkipRanges(line);
    const codeSpanRanges = findInlineCodeSpans(line);
    BARE_PATH_RE.lastIndex = 0;
    let match: RegExpExecArray | null = BARE_PATH_RE.exec(line);
    while (match !== null) {
      const boundary = match[1] ?? "";
      const path = match.groups?.path ?? "";
      const pathStart = match.index + boundary.length;
      const pathEnd = pathStart + path.length;
      if (path && !isInsideAnyRange(pathStart, hardSkipRanges) && !isDomainLike(path)) {
        const enclosing = findEnclosingRange(pathStart, codeSpanRanges);
        const entry: BarePathMatch = {
          raw: path,
          start: absoluteOffset + pathStart,
          end: absoluteOffset + pathEnd,
        };
        if (enclosing) {
          entry.enclosingCodeSpan = {
            start: absoluteOffset + enclosing.start,
            end: absoluteOffset + enclosing.end,
          };
        }
        out.push(entry);
      }
      match = BARE_PATH_RE.exec(line);
    }
    absoluteOffset += line.length;
  }
  return out;
}

function parseOpeningFence(line: string): FenceState | null {
  const match = FENCE_MARKER_RE.exec(line);
  const marker = match?.groups?.marker;
  if (!marker) return null;
  const markerChar = marker[0];
  if (markerChar !== "`" && markerChar !== "~") return null;
  // CommonMark: the info string of a backtick fence may not contain backticks
  // (such a line is a paragraph with inline code, e.g. "```pnpm test``` to
  // run"). Tilde-fence info strings have no such restriction.
  if (markerChar === "`" && line.slice(match[0].length).includes("`")) return null;
  return { marker: markerChar, length: marker.length };
}

function isClosingFence(line: string, fence: FenceState): boolean {
  const match = FENCE_MARKER_RE.exec(line);
  const marker = match?.groups?.marker;
  if (!marker || marker[0] !== fence.marker || marker.length < fence.length) return false;
  return /^[ \t]*$/.test(line.slice(match[0].length));
}

/**
 * Character ranges covered by markdown code — fenced blocks
 * (``` ``` ``` ``` / `~~~`) AND inline code spans (`` `…` ``, `` ``…`` ``, any
 * backtick-run length) — using the same CommonMark rules as
 * {@link scanBareDocPathTokens}: a closing fence must be the same marker char
 * and at least as long as the opener, an unclosed fence extends to
 * end-of-input, and an inline span closes on a backtick run of EXACTLY the
 * opener length. Inline spans may cross soft line breaks but NOT a blank-line
 * paragraph boundary and NOT a fenced block, so scanning is done per paragraph
 * region between fences/blank lines. The whole pass is linear in the text
 * length (fences via one line scan; inline via tokenize-once + a precomputed
 * next-equal-length-run index per region — no rescans). Returned as
 * `[start, end)` offsets, sorted by start (callers rely on that for a
 * monotonic-cursor lookup).
 */
export function markdownCodeSpanRanges(text: string): Array<{ start: number; end: number }> {
  const fenced: Array<{ start: number; end: number }> = [];
  const inline: Array<{ start: number; end: number }> = [];
  const lines = text.split(/(\r?\n)/);
  let fence: FenceState | null = null;
  let fenceStart = 0;
  let absoluteOffset = 0;
  // Current paragraph region [paraStart, paraEnd) of contiguous non-blank,
  // non-fence lines; -1 when between paragraphs. Inline spans never cross it.
  let paraStart = -1;
  let paraEnd = -1;
  const flushParagraph = (): void => {
    if (paraStart >= 0) collectInlineCodeInRegion(text, paraStart, paraEnd, inline);
    paraStart = -1;
    paraEnd = -1;
  };

  for (const line of lines) {
    if (line === "\n" || line === "\r\n") {
      absoluteOffset += line.length;
      continue;
    }
    if (fence) {
      if (isClosingFence(line, fence)) {
        fenced.push({ start: fenceStart, end: absoluteOffset + line.length });
        fence = null;
      }
      absoluteOffset += line.length;
      continue;
    }
    const opening = parseOpeningFence(line);
    if (opening) {
      flushParagraph();
      fence = opening;
      fenceStart = absoluteOffset;
      absoluteOffset += line.length;
      continue;
    }
    if (/^[ \t]*$/.test(line)) {
      flushParagraph(); // blank line — paragraph boundary
      absoluteOffset += line.length;
      continue;
    }
    if (paraStart < 0) paraStart = absoluteOffset;
    paraEnd = absoluteOffset + line.length;
    absoluteOffset += line.length;
  }
  flushParagraph();
  if (fence) fenced.push({ start: fenceStart, end: text.length });

  // Both lists are individually ordered; combine and sort so the result is
  // sorted by start (the caller relies on that for a monotonic-cursor lookup).
  return [...fenced, ...inline].sort((x, y) => x.start - y.start);
}

/**
 * Collect inline code span ranges within one paragraph region `[start, end)`.
 * Tokenize the backtick runs once, precompute for each run the next run of the
 * SAME length (a single right-to-left pass), then pair each opener with its
 * next-equal-length run — an opener with no equal-length successor is literal.
 * O(runs) with no per-opener rescan.
 */
function collectInlineCodeInRegion(
  text: string,
  start: number,
  end: number,
  out: Array<{ start: number; end: number }>,
): void {
  const runs: Array<{ start: number; end: number; len: number }> = [];
  for (let i = start; i < end; ) {
    if (text[i] !== "`") {
      i += 1;
      continue;
    }
    let j = i;
    while (j < end && text[j] === "`") j += 1;
    runs.push({ start: i, end: j, len: j - i });
    i = j;
  }
  if (runs.length < 2) return;

  const nextSameLen = new Array<number>(runs.length).fill(-1);
  const lastByLen = new Map<number, number>();
  for (let k = runs.length - 1; k >= 0; k -= 1) {
    const run = runs[k];
    if (!run) continue;
    const seen = lastByLen.get(run.len);
    nextSameLen[k] = seen === undefined ? -1 : seen;
    lastByLen.set(run.len, k);
  }

  for (let k = 0; k < runs.length; ) {
    const opener = runs[k];
    const close = nextSameLen[k] ?? -1;
    const closer = close === -1 ? undefined : runs[close];
    if (opener && closer) {
      out.push({ start: opener.start, end: closer.end });
      k = close + 1;
    } else {
      k += 1;
    }
  }
}

/**
 * Strip the `:line[:col]` suffix that agents often append to file references.
 * Returns the path portion (without the trailing line/column digits) so
 * callers can hand it to `normalizeDocLinkPath`. We accept and discard the
 * line/column information — preview-time line scrolling is out of scope
 * for the snapshot link path.
 */
export function stripDocPathLineSuffix(raw: string): string {
  const match = /^(?<path>.*?\.md)(?::\d+(?::\d+)?)?$/i.exec(raw);
  return match?.groups?.path ?? raw;
}

/**
 * Hard-skip ranges: constructs whose contents must never be reported as a doc
 * mention (the renderer already treats them specially or they semantically
 * are not a workspace path). Inline code spans live on a SEPARATE list — they
 * are still in scope, but get annotated rather than dropped.
 */
function findHardSkipRanges(line: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const match of line.matchAll(INLINE_MARKDOWN_LINK_RE)) {
    if (match.index !== undefined) ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  for (const match of line.matchAll(HTML_TAG_RE)) {
    if (match.index !== undefined) ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

/**
 * Single-line inline code spans, identified by a balanced run of N backticks
 * (N >= 1). Ranges are inclusive of the outer ticks so the rewrite pass can
 * replace the whole span without re-counting them. Unbalanced backtick runs
 * are skipped — they aren't really code spans, and the path scanner should
 * see through them as if they were literal text.
 */
function findInlineCodeSpans(line: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (let idx = 0; idx < line.length; ) {
    if (line[idx] !== "`") {
      idx += 1;
      continue;
    }
    const start = idx;
    while (line[idx] === "`") idx += 1;
    const openLen = idx - start;
    // Close only on a backtick run of EXACTLY openLen — a longer run is not a
    // close, so advance by whole runs rather than substring-matching (which
    // would end an N-tick span inside an N+1-tick run).
    let closeEnd = -1;
    for (let k = idx; k < line.length; ) {
      if (line[k] !== "`") {
        k += 1;
        continue;
      }
      let runEnd = k;
      while (runEnd < line.length && line[runEnd] === "`") runEnd += 1;
      if (runEnd - k === openLen) {
        closeEnd = runEnd;
        break;
      }
      k = runEnd;
    }
    if (closeEnd === -1) continue;
    ranges.push({ start, end: closeEnd });
    idx = closeEnd;
  }
  return ranges;
}

function isInsideAnyRange(index: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function findEnclosingRange(
  index: number,
  ranges: Array<{ start: number; end: number }>,
): { start: number; end: number } | null {
  for (const range of ranges) {
    if (index >= range.start && index < range.end) return range;
  }
  return null;
}

/**
 * Decide whether the first path segment looks like a bare domain name
 * (`example.com/...`) rather than a real `.md` filename. The check is
 * suppressed when the first segment already ends in `.md`, since a directory
 * named `notes.md/` is a legitimate workspace path even though it matches
 * the domain-shape regex.
 */
function isDomainLike(path: string): boolean {
  const firstSegment = path.split("/", 1).at(0) ?? "";
  if (firstSegment.toLowerCase().endsWith(".md")) return false;
  return DOMAIN_LIKE_PREFIX_RE.test(path);
}
