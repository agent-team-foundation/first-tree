import type { DocAnchor } from "./schemas/document.js";
import { DOC_ANCHOR_CONTEXT_MAX, DOC_ANCHOR_EXACT_MAX } from "./schemas/document.js";

/**
 * Anchor building / locating for document review (docloop) comments.
 *
 * A comment anchors to a range of the markdown SOURCE via a W3C
 * TextQuoteSelector-style `{ exact, prefix, suffix }`. The web UI builds
 * anchors from a selection made on RENDERED markdown, so the selected text
 * may differ from the source in whitespace and may omit inline syntax
 * (`**`, `` ` ``, link targets). Matching is therefore done on a
 * whitespace-normalized view of the source with an index map back to raw
 * offsets, and ambiguity is resolved by scoring the rendered context against
 * the source neighborhood.
 *
 * The same `locateDocAnchor` is what re-anchoring across versions uses:
 * anchors that no longer locate are surfaced as outdated rather than
 * silently dropped.
 */

/** Context captured around an anchor, in raw source characters. */
const ANCHOR_CONTEXT_CHARS = 48;

type NormalizedText = {
  /** Whitespace runs collapsed to single spaces, edges trimmed. */
  text: string;
  /** `map[i]` = raw-string offset of normalized char `i`. */
  map: number[];
};

/**
 * Collapse every whitespace run to one space and record, for each normalized
 * character, the raw offset it came from. Lets a match on the normalized view
 * be translated back to exact raw offsets.
 */
function normalizeWithMap(raw: string): NormalizedText {
  let text = "";
  const map: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] as string;
    if (/\s/.test(ch)) {
      pendingSpace = text.length > 0;
      continue;
    }
    if (pendingSpace) {
      text += " ";
      // A collapsed space maps to the raw offset of the char that follows it,
      // which keeps range math monotonic.
      map.push(i);
      pendingSpace = false;
    }
    text += ch;
    map.push(i);
  }
  return { text, map };
}

function normalize(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * Collapse whitespace WITHOUT trimming. Context strings keep their edge
 * spaces because the source neighborhood they are compared against retains
 * the single separator space (e.g. suffix " delta" must match neighborhood
 * " delta.", not "delta.").
 */
function collapseWhitespace(raw: string): string {
  return raw.replace(/\s+/g, " ");
}

function findAllOccurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    out.push(idx);
    idx = haystack.indexOf(needle, idx + 1);
  }
  return out;
}

/** Longest suffix of `context` that is a suffix of `neighborhood`, in chars. */
function suffixOverlap(context: string, neighborhood: string): number {
  const max = Math.min(context.length, neighborhood.length);
  let n = 0;
  while (n < max && context[context.length - 1 - n] === neighborhood[neighborhood.length - 1 - n]) n++;
  return n;
}

/** Longest prefix of `context` that is a prefix of `neighborhood`, in chars. */
function prefixOverlap(context: string, neighborhood: string): number {
  const max = Math.min(context.length, neighborhood.length);
  let n = 0;
  while (n < max && context[n] === neighborhood[n]) n++;
  return n;
}

type Occurrence = { normStart: number; normEnd: number };

function pickOccurrence(
  normSource: string,
  occurrences: number[],
  needleLength: number,
  beforeContext: string | undefined,
  afterContext: string | undefined,
): Occurrence {
  const first = occurrences[0] as number;
  if (occurrences.length === 1 || (!beforeContext && !afterContext)) {
    return { normStart: first, normEnd: first + needleLength };
  }
  const normBefore = beforeContext ? collapseWhitespace(beforeContext) : "";
  const normAfter = afterContext ? collapseWhitespace(afterContext) : "";
  let best = first;
  let bestScore = -1;
  for (const start of occurrences) {
    const neighborhoodBefore = normSource.slice(Math.max(0, start - 200), start);
    const neighborhoodAfter = normSource.slice(start + needleLength, start + needleLength + 200);
    const score = suffixOverlap(normBefore, neighborhoodBefore) + prefixOverlap(normAfter, neighborhoodAfter);
    if (score > bestScore) {
      bestScore = score;
      best = start;
    }
  }
  return { normStart: best, normEnd: best + needleLength };
}

/** Translate a normalized-view range back to raw offsets `{ start, end }`. */
function toRawRange(norm: NormalizedText, normStart: number, normEnd: number): { start: number; end: number } {
  const start = norm.map[normStart] as number;
  const lastCharRaw = norm.map[normEnd - 1] as number;
  return { start, end: lastCharRaw + 1 };
}

export type DocAnchorRange = { start: number; end: number };

export type BuildDocAnchorInput = {
  /** Markdown source of the version being commented on. */
  source: string;
  /** Text the user selected (typically from the rendered view). */
  selectedText: string;
  /** Rendered text immediately before the selection, for disambiguation. */
  renderedPrefix?: string;
  /** Rendered text immediately after the selection, for disambiguation. */
  renderedSuffix?: string;
};

/**
 * Build a source-based anchor from a (rendered) selection. Returns null when
 * the selected text cannot be found in the source at all — e.g. the
 * selection spans inline markdown syntax; callers should then fall back to a
 * document-level comment that quotes the text in its body.
 */
export function buildDocAnchor(input: BuildDocAnchorInput): DocAnchor | null {
  const normSelected = normalize(input.selectedText);
  if (normSelected.length === 0 || normSelected.length > DOC_ANCHOR_EXACT_MAX) return null;

  const norm = normalizeWithMap(input.source);
  const occurrences = findAllOccurrences(norm.text, normSelected);
  if (occurrences.length === 0) return null;

  const picked = pickOccurrence(
    norm.text,
    occurrences,
    normSelected.length,
    input.renderedPrefix,
    input.renderedSuffix,
  );
  const range = toRawRange(norm, picked.normStart, picked.normEnd);

  const prefix = input.source.slice(Math.max(0, range.start - ANCHOR_CONTEXT_CHARS), range.start);
  const suffix = input.source.slice(range.end, range.end + ANCHOR_CONTEXT_CHARS);
  return {
    exact: input.source.slice(range.start, range.end),
    ...(prefix.length > 0 ? { prefix: prefix.slice(-DOC_ANCHOR_CONTEXT_MAX) } : {}),
    ...(suffix.length > 0 ? { suffix: suffix.slice(0, DOC_ANCHOR_CONTEXT_MAX) } : {}),
  };
}

/**
 * Locate an anchor inside (a possibly different version of) the source.
 * Whitespace-insensitive; ambiguity resolves through the stored
 * prefix/suffix. Returns raw offsets, or null when the quote no longer
 * exists — the caller decides what "outdated" means.
 */
export function locateDocAnchor(source: string, anchor: DocAnchor): DocAnchorRange | null {
  const normExact = normalize(anchor.exact);
  if (normExact.length === 0) return null;

  const norm = normalizeWithMap(source);
  const occurrences = findAllOccurrences(norm.text, normExact);
  if (occurrences.length === 0) return null;

  const picked = pickOccurrence(norm.text, occurrences, normExact.length, anchor.prefix, anchor.suffix);
  return toRawRange(norm, picked.normStart, picked.normEnd);
}
