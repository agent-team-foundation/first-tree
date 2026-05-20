import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  MAX_DOC_SNAPSHOT_BYTES,
  MAX_DOC_SNAPSHOTS_PER_MESSAGE,
  MAX_TOTAL_DOC_SNAPSHOT_BYTES,
  normalizeDocLinkPath,
  type SnapshotDoc,
  scanBareDocPathTokens,
  stripDocPathLineSuffix,
} from "@agent-team-foundation/first-tree-hub-shared";

/**
 * Scan an outbound agent message for `.md` path mentions (inline markdown
 * links `[text](path.md)` AND bare `path.md` tokens) and turn each
 * safely-resolvable target into a snapshot of the file's contents at send
 * time.
 *
 * Resolution is constrained to `root`. A path resolves when its real target
 * is a regular `.md` file physically inside the worktree with no hidden
 * segment. Two written forms resolve:
 *   - workspace-relative (`docs/foo.md`, `./docs/foo.md`); and
 *   - **absolute paths that land inside `root`** (`<root>/docs/foo.md`).
 *     Web cannot map an absolute path back to a snapshot key (it does not
 *     know `root`), so for every resolved token whose written form is not
 *     already the canonical relative path, we **rewrite that span in the
 *     outbound text** to the canonical relative path (preserving any
 *     `:line[:col]` suffix). The caller sends `rewrittenText`, and web's
 *     unchanged re-scan then sees a relative token, matches the snapshot,
 *     and renders the preview link. This keeps web/server/schema untouched
 *     and is immune to server-side body rewrites (e.g. `@mention` prepend)
 *     because web re-scans rather than trusting byte offsets.
 *
 * Anything that escapes the worktree (absolute path resolving OUTSIDE root,
 * `..` traversal, symlink pointing to a hidden segment inside or outside
 * root), hides (`.dotfile` / `.dotdir`, `.agent/`), or is missing is dropped
 * — the caller's message still goes through, the offending mention simply
 * stays plain text in the UI (and is left untouched in `rewrittenText`).
 *
 * The shared schema enforces canonical path form and the server re-validates
 * byte budgets + sha256 so a misbehaving runtime cannot lodge mismatched
 * data.
 */
export async function buildMessageDocumentSnapshots(
  text: string,
  root: string,
): Promise<{ docs: SnapshotDoc[]; skipped: number; rewrittenText: string }> {
  const occurrences = collectDocPathOccurrences(text);
  if (occurrences.length === 0) return { docs: [], skipped: 0, rewrittenText: text };

  const rootReal = await safeRealpath(root);
  if (!rootReal) return { docs: [], skipped: occurrences.length, rewrittenText: text };

  // Pass 1 — resolve every occurrence to its canonical workspace-relative key
  // (or null). Absolute-in-root paths canonicalise to the same relative key
  // web derives once the text is rewritten, so a click hits the snapshot.
  const resolved = await Promise.all(
    occurrences.map(async (occ) => ({
      ...occ,
      canonical: await canonicalizeWorkspacePath(rootReal, occ.writtenPath),
    })),
  );

  // Pass 2 — build snapshots. De-dupe by canonical path so the same file
  // mentioned twice is read once; the on-wire key is the canonical path the
  // web cache lookup produces from a clicked href.
  const docs: SnapshotDoc[] = [];
  let totalBytes = 0;
  let skipped = 0;
  const seen = new Set<string>();
  const snapshotted = new Set<string>();

  for (const occ of resolved) {
    const canonical = occ.canonical;
    if (!canonical || !canonical.toLowerCase().endsWith(".md")) {
      skipped += 1;
      continue;
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);

    if (docs.length >= MAX_DOC_SNAPSHOTS_PER_MESSAGE) {
      skipped += 1;
      continue;
    }

    const file = await resolveWorkspaceFile(rootReal, canonical);
    if (!file) {
      skipped += 1;
      continue;
    }

    try {
      const buf = await readFile(file);
      // Pre-flight raw-byte cap so a multi-MB file doesn't waste a full UTF-8
      // round-trip just to be rejected below.
      if (buf.byteLength > MAX_DOC_SNAPSHOT_BYTES) {
        skipped += 1;
        continue;
      }
      const content = buf.toString("utf8");
      // `size` MUST match the byte length the server recomputes from
      // `content` (see `services/doc-snapshots.ts validateDocumentContext`).
      // Files that contain invalid UTF-8 sequences have `buf.toString("utf8")`
      // substitute U+FFFD for each malformed byte, so `buf.byteLength` (raw)
      // drifts from `Buffer.byteLength(content, "utf8")` (re-encoded) and the
      // server rejects the message with "size does not match content".
      // Compute size from the round-tripped content so both sides agree.
      const size = Buffer.byteLength(content, "utf8");
      // After substitution `size` may grow (a single invalid byte → 3 bytes
      // for U+FFFD) and overshoot the per-file cap even if raw bytes were
      // under. Catch that and skip.
      if (size > MAX_DOC_SNAPSHOT_BYTES) {
        skipped += 1;
        continue;
      }
      if (totalBytes + size > MAX_TOTAL_DOC_SNAPSHOT_BYTES) {
        skipped += 1;
        continue;
      }
      const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
      docs.push({ path: canonical, sha256, size, content });
      totalBytes += size;
      snapshotted.add(canonical);
    } catch {
      skipped += 1;
    }
  }

  // Pass 3 — rewrite the text spans of resolved ABSOLUTE-in-root tokens to
  // their canonical relative path (web can't map an absolute path to a
  // snapshot key without knowing `root`). The rewrite surface is kept minimal:
  // relative mentions — canonical or not (`./docs/foo.md`) — are left verbatim
  // because web already canonicalises them during its re-scan match. Only
  // tokens that actually produced a snapshot are rewritten, so "rewritten ⇔
  // previewable" holds and an unsnapshot-able mention is never mutated.
  const rewrites: Array<{ start: number; end: number; replacement: string }> = [];
  for (const occ of resolved) {
    if (occ.canonical && isAbsolute(occ.writtenPath) && snapshotted.has(occ.canonical)) {
      rewrites.push({ start: occ.start, end: occ.end, replacement: `${occ.canonical}${occ.lineSuffix}` });
    }
  }

  return { docs, skipped, rewrittenText: applyRewrites(text, rewrites) };
}

/**
 * One `.md` path mention found in the outbound text, with the exact text span
 * to replace if the path resolves to a workspace file.
 *
 * - `writtenPath` is the path as authored, minus any `:line[:col]` suffix.
 * - `lineSuffix` is that suffix verbatim ("" when absent) so a rewrite can
 *   preserve `foo.md:12`.
 * - `[start, end)` is the slice to replace: the whole bare token (incl. the
 *   line suffix) for bare mentions, or just the `(target)` for inline links.
 */
type DocPathOccurrence = {
  writtenPath: string;
  lineSuffix: string;
  start: number;
  end: number;
};

function collectDocPathOccurrences(text: string): DocPathOccurrence[] {
  const out: DocPathOccurrence[] = [];
  for (const link of scanInlineMarkdownLinks(text)) {
    out.push({ writtenPath: link.target, lineSuffix: "", start: link.start, end: link.end });
  }
  for (const m of scanBareDocPathTokens(text)) {
    const writtenPath = stripDocPathLineSuffix(m.raw);
    out.push({ writtenPath, lineSuffix: m.raw.slice(writtenPath.length), start: m.start, end: m.end });
  }
  return out;
}

/** Apply non-overlapping `[start, end) → replacement` edits to `text`. */
function applyRewrites(text: string, rewrites: Array<{ start: number; end: number; replacement: string }>): string {
  if (rewrites.length === 0) return text;
  const ordered = [...rewrites].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const edit of ordered) {
    if (edit.start < cursor) continue; // defensive: bare/inline spans never overlap
    out += text.slice(cursor, edit.start);
    out += edit.replacement;
    cursor = edit.end;
  }
  out += text.slice(cursor);
  return out;
}

type InlineLinkMatch = { target: string; start: number; end: number };

/**
 * Inline markdown link scanner. Conservative: requires a literal `[ ... ](path.md)`
 * pair (with optional title segment ignored) where the path captures up to the
 * first whitespace or `)`. Reference-style / autolink / HTML / escaped /
 * image forms are deliberately not matched (proposal §非目标).
 *
 * The leading `[ ... ](` is captured as group 1 so the target's start offset
 * is `match.index + group1.length` — used to rewrite an absolute-in-root
 * target in place without re-searching the string.
 *
 * Two forms are excluded by inspecting the byte preceding the opening `[`:
 *   - `\[text](path.md)` — markdown-escaped bracket
 *   - `![alt](path.md)` — image, not a click target
 */
function scanInlineMarkdownLinks(text: string): InlineLinkMatch[] {
  const out: InlineLinkMatch[] = [];
  const re = /(\[(?:[^\]\\]|\\.)*\]\()(\S+?\.md)(?:\s+"[^"]*")?\)/g;
  let match: RegExpExecArray | null = re.exec(text);
  while (match !== null) {
    const linkStart = match.index;
    const prev = linkStart > 0 ? text[linkStart - 1] : "";
    const prefix = match[1];
    const target = match[2];
    if (prev !== "\\" && prev !== "!" && prefix !== undefined && target) {
      const start = linkStart + prefix.length;
      out.push({ target, start, end: start + target.length });
    }
    match = re.exec(text);
  }
  return out;
}

/**
 * Resolve the canonical workspace-relative key for a written `.md` path,
 * accepting BOTH relative paths and absolute paths that land inside the
 * workspace root.
 *
 * Absolute paths are `realpath`'d FIRST, then checked for containment — so an
 * ancestor symlink cannot be used to claim a path is "inside" the root when
 * its real target is not. The relative result is run back through
 * `normalizeDocLinkPath` so the key is POSIX-canonical and any hidden segment
 * exposed by the realpath (`<root>/.agent/x.md` reached via a symlink) is
 * rejected — matching what web's re-scan derives from the rewritten relative
 * token. Returns null when the path escapes the root, hides, or cannot be
 * realpath'd; the caller then leaves the text untouched and embeds no snapshot.
 */
async function canonicalizeWorkspacePath(rootReal: string, writtenPath: string): Promise<string | null> {
  if (!isAbsolute(writtenPath)) return normalizeDocLinkPath(writtenPath);

  const real = await safeRealpath(writtenPath);
  if (!real) return null;
  const prefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  if (real !== rootReal && !real.startsWith(prefix)) return null;
  return normalizeDocLinkPath(relative(rootReal, real));
}

/**
 * Resolve a canonical workspace-relative link target against `rootReal`.
 * Returns the real path of a regular `.md` file that is **physically** inside
 * the worktree AND whose real path contains no hidden segments. The second
 * check is the bit that closes the symlink-into-`.agent` / -`.git` /
 * -dotfile escape: a link like `docs/public.md` could be a symlink whose
 * realpath is `<root>/.agent/secret.md` — link-level segment check would
 * allow it (no dot in `docs/public.md`), so we re-check after realpath.
 *
 * Callers must pass a canonical path (no leading "/", no "./", no "..", no
 * dot segments) — `buildMessageDocumentSnapshots` runs `normalizeDocLinkPath`
 * before invoking this function.
 */
async function resolveWorkspaceFile(rootReal: string, canonicalPath: string): Promise<string | null> {
  if (!canonicalPath || isAbsolute(canonicalPath)) return null;

  const candidate = resolve(rootReal, canonicalPath);
  const candidateReal = await safeRealpath(candidate);
  if (!candidateReal) return null;

  // 1. Real target must still be inside (or equal to) the workspace root.
  const prefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  if (candidateReal !== rootReal && !candidateReal.startsWith(prefix)) return null;

  // 2. Real target's path relative to root must not include any hidden
  //    segment. Catches the case where a non-hidden link path points at a
  //    symlink whose realpath drops into `.agent/`, `.git/`, dotfiles, etc.
  const rel = relative(rootReal, candidateReal);
  const realSegments = rel.split(sep).filter((s) => s.length > 0 && s !== ".");
  if (realSegments.some((s) => s.startsWith("."))) return null;

  try {
    const st = await stat(candidateReal);
    if (!st.isFile()) return null;
  } catch {
    return null;
  }
  return candidateReal;
}

async function safeRealpath(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}
