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
 *   - inline code spans `` `...` ``
 *   - fenced code blocks (``` ``` ``` ``` / `~~~`)
 *   - indented code blocks (4+ spaces or leading tab)
 *   - HTML tag bodies `<...>` (so href / src attribute values aren't
 *     re-linkified)
 *   - reference-link definitions `[ref]: target`
 *   - domain-shaped tokens like `example.com/readme.md` — these are URLs the
 *     user almost certainly meant as external links, not workspace paths.
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
  /(^|[\s([{"'])(?<path>(?:\.{1,2}\/|\/)?(?:[A-Za-z0-9_.~+@%-]+\/)*[A-Za-z0-9_.~+@%-]+\.md(?::\d+(?::\d+)?)?)(?=$|[\s)\]}"',.;!?])/g;

const INLINE_MARKDOWN_LINK_RE = /\[(?:[^\]\\\n]|\\.)*\]\([^)\n]*\)/g;
const REFERENCE_LINK_DEFINITION_RE = /^\s*\[[^\]\n]+\]:\s*\S+/;
const HTML_TAG_RE = /<\/?[A-Za-z][^>\n]*>/g;
const FENCE_OPEN_RE = /^\s*(```|~~~)/;
const INDENT_CODE_RE = /^(?: {4}|\t)/;
const DOMAIN_LIKE_PREFIX_RE = /^[a-z][a-z0-9.-]*\.[a-z]{2,}\//i;

export type BarePathMatch = {
  /** The raw token as it appears in the text, including any `:line[:col]`. */
  raw: string;
  /** Byte offset (UTF-16 code-unit offset) of `raw` inside the input string. */
  start: number;
  /** Byte offset of the character just after `raw`. */
  end: number;
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
  let inFence = false;
  let absoluteOffset = 0;

  for (const line of lines) {
    if (line === "\n" || line === "\r\n") {
      absoluteOffset += line.length;
      continue;
    }
    if (FENCE_OPEN_RE.test(line)) {
      inFence = !inFence;
      absoluteOffset += line.length;
      continue;
    }
    if (inFence) {
      absoluteOffset += line.length;
      continue;
    }
    if (INDENT_CODE_RE.test(line) || REFERENCE_LINK_DEFINITION_RE.test(line)) {
      absoluteOffset += line.length;
      continue;
    }

    const skipRanges = findInlineSkipRanges(line);
    BARE_PATH_RE.lastIndex = 0;
    let match: RegExpExecArray | null = BARE_PATH_RE.exec(line);
    while (match !== null) {
      const boundary = match[1] ?? "";
      const path = match.groups?.path ?? "";
      const pathStart = match.index + boundary.length;
      const pathEnd = pathStart + path.length;
      if (path && !isInsideAnyRange(pathStart, skipRanges) && !isDomainLike(path)) {
        out.push({ raw: path, start: absoluteOffset + pathStart, end: absoluteOffset + pathEnd });
      }
      match = BARE_PATH_RE.exec(line);
    }
    absoluteOffset += line.length;
  }
  return out;
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

function findInlineSkipRanges(line: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];

  for (const match of line.matchAll(INLINE_MARKDOWN_LINK_RE)) {
    if (match.index !== undefined) ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  for (const match of line.matchAll(HTML_TAG_RE)) {
    if (match.index !== undefined) ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  for (let idx = 0; idx < line.length; ) {
    if (line[idx] !== "`") {
      idx += 1;
      continue;
    }
    const start = idx;
    while (line[idx] === "`") idx += 1;
    const ticks = line.slice(start, idx);
    const end = line.indexOf(ticks, idx);
    if (end === -1) continue;
    ranges.push({ start, end: end + ticks.length });
    idx = end + ticks.length;
  }
  return ranges;
}

function isInsideAnyRange(index: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
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
