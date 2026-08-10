import {
  type ContextDecision,
  type ContextDecisionEffect,
  type ContextDecisionEvidence,
  contextDecisionSchema,
  MAX_CONTEXT_DECISION_EVIDENCE,
} from "./context-decision.js";

/**
 * The visible Context Tree impact note — the three-line Markdown blockquote an
 * agent appends to its final response when Tree content materially shaped a
 * choice. `first-tree-read` owns the authoring contract; this module owns
 * reading it back.
 *
 * Two consumers share this parser on purpose:
 *
 *   - the Server derives `metadata.contextDecision` from the note at message
 *     write time, so the machine-counted record and the human-visible claim
 *     cannot drift — they are the same sentence;
 *   - `@first-tree/skill-evals` grades note format against the same regexes it
 *     is graded by, so a format change turns both red at once instead of
 *     letting the eval quietly bless something the Server cannot read.
 *
 * Parsing is deliberately fail-closed at the CONVERSION step, not the scan
 * step: `parseContextImpactNotes` reports what it saw (including malformed
 * notes, which the eval needs in order to fail them), while
 * `contextDecisionFromImpactNote` returns `null` unless every field a receipt
 * promises is present and valid.
 */

export const CONTEXT_IMPACT_NOTE_LANGUAGES = ["en", "zh"] as const;
export type ContextImpactNoteLanguage = (typeof CONTEXT_IMPACT_NOTE_LANGUAGES)[number];

/**
 * The fixed visible label per effect, per language. The enum key never reaches
 * a reader; these strings are the contract between the authoring skill, the
 * eval that grades it, and this parser.
 */
export const CONTEXT_IMPACT_NOTE_EFFECT_LABELS: Record<
  ContextImpactNoteLanguage,
  Record<ContextDecisionEffect, string>
> = {
  en: {
    conflicted: "Conflict surfaced",
    confirmed: "Direction supported",
    constrained: "Options narrowed",
    redirected: "Approach changed",
  },
  zh: {
    conflicted: "发现约束冲突",
    confirmed: "支持当前方向",
    constrained: "收窄可选范围",
    redirected: "改变方案路径",
  },
};

const EFFECT_BY_LABEL: Record<ContextImpactNoteLanguage, ReadonlyMap<string, ContextDecisionEffect>> = {
  en: new Map(
    Object.entries(CONTEXT_IMPACT_NOTE_EFFECT_LABELS.en).map(([effect, label]) => [
      label,
      effect as ContextDecisionEffect,
    ]),
  ),
  zh: new Map(
    Object.entries(CONTEXT_IMPACT_NOTE_EFFECT_LABELS.zh).map(([effect, label]) => [
      label,
      effect as ContextDecisionEffect,
    ]),
  ),
};

/** `heading` is display-only; a label longer than the schema allows is dropped, not fatal. */
const MAX_EVIDENCE_HEADING_LENGTH = 200;
/**
 * Source lines longer than this carry no links at all rather than being
 * scanned. Three exact-commit citations plus their labels fit in a small
 * fraction of it, so the only thing this refuses is a pathological body.
 */
const MAX_SOURCE_LINE_LENGTH = 8_000;

export type ContextImpactNoteSource = {
  /** The readable Markdown link label, e.g. `Rollout Policy · Expansion gates`. */
  label: string;
  url: string;
};

/**
 * One note found in a body, with the format observations a grader needs. Every
 * `*Ok` flag answers a single question about the note's own three lines;
 * position-in-conversation checks (which message carried it, whether it rode a
 * blocking question) belong to the caller, which has that context.
 */
export type ContextImpactNote = {
  /** 0-based index of the note's first line within the parsed text. */
  lineIndex: number;
  language: ContextImpactNoteLanguage;
  /** The visible label exactly as written; empty when the effect line is malformed. */
  effectLabel: string;
  summary: string;
  sources: readonly ContextImpactNoteSource[];
  /** Every line after the note is blank — the note sits at the very end. */
  atEnd: boolean;
  blankLineBefore: boolean;
  /** Effect and source lines both matched, and no fourth blockquote line follows. */
  logicalLinesOk: boolean;
  /** Source line carries the exact fixed scaffolding, separators included. */
  sourceScaffoldingOk: boolean;
  /** Every link resolves to an exact-commit, credential-free file URL. */
  exactLinksOk: boolean;
  /** Written in the superseded bold-title scaffold rather than the current one. */
  legacyScaffold: boolean;
};

export type ExactContextSourceLink = {
  commit: string;
  nodePath: string;
  /** Credential-free repository URL rebuilt from the link, e.g. `https://github.com/acme/tree`. */
  repoUrl: string;
  /** Lowercased `host/path`, for comparing two spellings of the same repository. */
  repositoryIdentity: string;
};

/**
 * Rebuild the cited repository, commit, and node path from a forge blob URL.
 *
 * Returns `null` for anything that is not an exact-commit, credential-free
 * `https` file link — a branch link names a moving target, and a URL carrying
 * a username, password, query, or fragment must never be persisted or shown.
 * GitLab's `/-/blob/` infix is accepted alongside GitHub's `/blob/`, so a
 * subgroup path resolves to the repository rather than to `.../-`.
 */
export function parseExactContextSourceLink(value: string): ExactContextSourceLink | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return null;
  }

  const segments = url.pathname.split("/").filter(Boolean);
  const blobIndex = segments.findIndex(
    (segment, index) => segment === "blob" && /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/u.test(segments[index + 1] ?? ""),
  );
  if (blobIndex <= 0 || blobIndex + 2 >= segments.length) return null;
  const repositoryEnd = segments[blobIndex - 1] === "-" ? blobIndex - 1 : blobIndex;
  if (repositoryEnd <= 0) return null;

  const repositoryPath = segments
    .slice(0, repositoryEnd)
    .join("/")
    .replace(/\.git$/iu, "");
  // `new URL` accepts a malformed escape such as `%E0%A4%A` that
  // `decodeURIComponent` then throws a URIError on. This parser runs
  // synchronously inside the message-send preflight, so an unguarded throw
  // would turn one bad link into a 500 instead of the documented null.
  let nodePath: string;
  try {
    nodePath = segments
      .slice(blobIndex + 2)
      .map((segment) => decodeURIComponent(segment))
      .join("/");
  } catch {
    return null;
  }
  if (repositoryPath.length === 0 || nodePath.length === 0) return null;

  return {
    commit: segments[blobIndex + 1]?.toLowerCase() ?? "",
    nodePath,
    repoUrl: `${url.protocol}//${url.host}/${repositoryPath}`,
    repositoryIdentity: `${url.host.toLowerCase()}/${repositoryPath.toLowerCase()}`,
  };
}

/**
 * Find every impact note in a body.
 *
 * Malformed notes are still returned — a grader has to see a broken note to
 * fail it, and the Server's conversion step is what refuses to persist one.
 * Scanning is anchored on the fixed title line, so ordinary prose that merely
 * quotes a Tree passage is never mistaken for a note.
 */
export function parseContextImpactNotes(text: string): ContextImpactNote[] {
  const notes: ContextImpactNote[] = [];
  const lines = text.replace(/\r/gu, "").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const firstLine = lines[index] ?? "";
    // Only the effect label is bold in the current scaffold: the first and
    // third lines carry the same fixed wording in every note, so the single
    // bold span stays the reader's entry point. A bolded first line is the
    // superseded scaffold — recognised so history still parses, but reported
    // as legacy rather than silently accepted as current.
    const titleMatch = /^> (How Context Tree affected this work|Context Tree 如何影响本次工作)\\$/u.exec(firstLine);
    const currentTitleScaffoldMatch =
      /^> (How Context Tree affected this work|Context Tree 如何影响本次工作)\\?\s*$/u.exec(firstLine);
    const legacyTitleMatch = /^> \*\*(Context Tree impact|Context Tree 影响)(?: · ([^*]+))?\*\*\\?\s*$/u.exec(
      firstLine,
    );
    if (!currentTitleScaffoldMatch && !legacyTitleMatch) continue;

    const language: ContextImpactNoteLanguage =
      currentTitleScaffoldMatch?.[1] === "Context Tree 如何影响本次工作" ||
      legacyTitleMatch?.[1] === "Context Tree 影响"
        ? "zh"
        : "en";
    const secondLine = lines[index + 1] ?? "";
    const thirdLine = lines[index + 2] ?? "";
    // Chinese puts the full-width colon OUTSIDE the bold span: Markdown cannot
    // close `**` when the delimiter is preceded by punctuation and followed by
    // a CJK character, so the colon-inside form renders as literal asterisks.
    // Every repetition below is explicitly bounded. These patterns run on
    // agent-authored message bodies — uncontrolled input on the synchronous
    // send path — and an unbounded `+` here is a polynomial-backtracking DoS
    // (CodeQL js/polynomial-redos). The bounds sit far above the authoring
    // contract's own limits, so a legitimate note is never the one truncated.
    const effectMatch =
      language === "zh"
        ? /^> \*\*([^*]{1,120})\*\*：([^\s].{0,3999})\\$/u.exec(secondLine)
        : /^> \*\*([^*]{1,120}):\*\* (.{1,4000})\\$/u.exec(secondLine);
    const sourcePrefix = language === "zh" ? /^> Context Tree 来源：/u : /^> Context Tree (source|sources): /u;
    const sourcePrefixMatch = sourcePrefix.exec(thirdLine);
    const markdownLinks =
      thirdLine.length <= MAX_SOURCE_LINE_LENGTH
        ? [...thirdLine.matchAll(/\[([^\]\n]{1,400})\]\(([^)\s]{1,2048})\)/gu)]
        : [];
    const exactLinkCount = markdownLinks.filter((match) => parseExactContextSourceLink(match[2] ?? "") !== null).length;
    const expectedEnglishSource = markdownLinks.length === 1 ? "source" : "sources";
    const sourceLabel = language === "zh" ? "Context Tree 来源" : `Context Tree ${expectedEnglishSource}:`;
    const sourceSeparator = language === "zh" ? "：" : " ";
    const expectedSourceLine = `> ${sourceLabel}${sourceSeparator}${markdownLinks.map((match) => match[0]).join(" · ")}`;

    notes.push({
      atEnd: lines.slice(index + 3).every((line) => line.trim() === ""),
      blankLineBefore: index > 0 && (lines[index - 1] ?? "").trim() === "",
      effectLabel: effectMatch?.[1]?.trim() ?? legacyTitleMatch?.[2]?.trim() ?? "",
      exactLinksOk: exactLinkCount === markdownLinks.length && exactLinkCount > 0,
      language,
      legacyScaffold: legacyTitleMatch !== null,
      lineIndex: index,
      logicalLinesOk: effectMatch !== null && sourcePrefixMatch !== null && !(lines[index + 3] ?? "").startsWith(">"),
      sourceScaffoldingOk:
        titleMatch !== null &&
        sourcePrefixMatch !== null &&
        (language === "zh" || sourcePrefixMatch[1] === expectedEnglishSource) &&
        markdownLinks.length > 0 &&
        thirdLine === expectedSourceLine,
      sources: markdownLinks.map((match) => ({ label: match[1] ?? "", url: match[2] ?? "" })),
      summary: effectMatch?.[2]?.trim() ?? "",
    });
  }

  return notes;
}

/**
 * Every observation a note must satisfy before it can become a receipt.
 *
 * This is the whole point of one shared parser: `parseContextImpactNotes` is
 * permissive so a grader can SEE a broken note and fail it, but a note the
 * eval rejects must never be one the Server persists. Requiring the same flags
 * the eval grades on is what keeps those two answers identical instead of
 * letting the Server quietly accept a superseded scaffold, a note buried
 * mid-message, or a fourth blockquote line the reader never asked for.
 */
export function isConvertibleContextImpactNote(note: ContextImpactNote): boolean {
  return (
    !note.legacyScaffold &&
    note.logicalLinesOk &&
    note.sourceScaffoldingOk &&
    note.exactLinksOk &&
    note.atEnd &&
    note.blankLineBefore
  );
}

/**
 * Convert a parsed note into the durable receipt, or `null` when anything a
 * receipt promises is missing or the note is not in the current valid shape.
 *
 * Fail-closed on the whole note rather than storing a partial one: a receipt
 * whose evidence cannot be inspected is a claim, and the inspectable source is
 * the only part First Tree can vouch for. The one soft failure is `heading`,
 * which is display sugar — an over-long label is dropped so the citation
 * itself survives.
 */
export function contextDecisionFromImpactNote(note: ContextImpactNote): ContextDecision | null {
  if (!isConvertibleContextImpactNote(note)) return null;
  const effect = EFFECT_BY_LABEL[note.language].get(note.effectLabel);
  if (!effect) return null;

  const evidence: ContextDecisionEvidence[] = [];
  const seen = new Set<string>();
  for (const source of note.sources) {
    const link = parseExactContextSourceLink(source.url);
    if (!link) return null;
    // Repository + commit + path is the node's identity at an exact version. A
    // node cited twice in one note is one influenced decision, not two — so
    // deduping here is what keeps the per-node ranking honest downstream
    // instead of letting a repeated citation inflate it.
    const key = `${link.repoUrl}@${link.commit}:${link.nodePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const heading = source.label.trim();
    evidence.push({
      commit: link.commit,
      nodePath: link.nodePath,
      repoUrl: link.repoUrl,
      ...(heading.length > 0 && heading.length <= MAX_EVIDENCE_HEADING_LENGTH ? { heading } : {}),
    });
  }
  if (evidence.length === 0 || evidence.length > MAX_CONTEXT_DECISION_EVIDENCE) return null;

  const parsed = contextDecisionSchema.safeParse({
    effect,
    evidence,
    summary: note.summary,
    version: 1,
  });
  return parsed.success ? parsed.data : null;
}
