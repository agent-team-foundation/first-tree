import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  buildWorkspaceDocKey,
  MAX_DOC_SNAPSHOT_BYTES,
  MAX_DOC_SNAPSHOTS_PER_MESSAGE,
  MAX_TOTAL_DOC_SNAPSHOT_BYTES,
  normalizeDocLinkPath,
  type SnapshotDoc,
  scanBareDocPathTokens,
  stripDocPathLineSuffix,
} from "@first-tree/shared";

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
/**
 * Fence that widens snapshotting from "the sender's own workspace root" to
 * "any agent's workspace under the shared `workspaces/` common root, scoped to
 * the current chat". Passed by the runtime; absent in legacy/unit call sites,
 * in which case behaviour is exactly the pre-existing self-only path.
 */
export type WorkspaceFence = {
  /** Shared `workspaces/` common root (parent of every `<agentSlug>/<chatId>`). */
  workspacesRoot: string;
  /** Current chat — only `<*>/<chatId>/…` files are in scope. */
  chatId: string;
  /** Sender's own dir name under `workspacesRoot`; excluded from cross-resolution. */
  selfSlug: string;
};

type ResolvedOccurrence = DocPathOccurrence & {
  kind: "self" | "cross" | null;
  /** Snapshot key: bare base-relative for self, global `<slug>/<chatId>/<rel>` for cross. */
  key: string | null;
  /** Realpath of the file to read (cross only; self resolves against `root`). */
  file: string | null;
  /** Rewrite replacement for a cross mention: short `<ownerSlug>/<rel>`. */
  shortForm: string;
};

export async function buildMessageDocumentSnapshots(
  text: string,
  root: string,
  fence?: WorkspaceFence,
): Promise<{ docs: SnapshotDoc[]; skipped: number; rewrittenText: string }> {
  const occurrences = collectDocPathOccurrences(text);
  if (occurrences.length === 0) return { docs: [], skipped: 0, rewrittenText: text };

  const rootReal = await safeRealpath(root);
  if (!rootReal) return { docs: [], skipped: occurrences.length, rewrittenText: text };

  const workspacesRootReal = fence ? await safeRealpath(fence.workspacesRoot) : null;

  // Pass 1 — resolve every occurrence to a snapshot plan:
  //   self  → bare key relative to `root` (unchanged from #474/#480); the
  //           absolute-in-root case canonicalises to the same relative key web
  //           derives once the text is rewritten.
  //   cross → global key `<ownerSlug>/<chatId>/<rel>` for a file that realpaths
  //           into ANOTHER agent's workspace under the shared common root.
  const resolved: ResolvedOccurrence[] = await Promise.all(
    occurrences.map(async (occ): Promise<ResolvedOccurrence> => {
      const selfKey = await canonicalizeWorkspacePath(rootReal, occ.writtenPath);
      if (selfKey) return { ...occ, kind: "self", key: selfKey, file: null, shortForm: "" };
      // Only an ABSOLUTE path can escape the sender's own root into a sibling
      // workspace; a relative mention always resolves under `root`.
      if (workspacesRootReal && fence && isAbsolute(occ.writtenPath)) {
        const cross = await resolveCrossWorkspaceDoc(workspacesRootReal, fence, occ.writtenPath);
        if (cross) return { ...occ, kind: "cross", key: cross.key, file: cross.file, shortForm: cross.shortForm };
      }
      return { ...occ, kind: null, key: null, file: null, shortForm: "" };
    }),
  );

  // Pass 2 — build snapshots. De-dupe by snapshot key so the same file
  // mentioned twice is read once; the on-wire key is what the web cache lookup
  // produces from a clicked href.
  const docs: SnapshotDoc[] = [];
  let totalBytes = 0;
  let skipped = 0;
  const seen = new Set<string>();
  const snapshotted = new Set<string>();

  for (const occ of resolved) {
    const key = occ.key;
    if (!key || !key.toLowerCase().endsWith(".md")) {
      skipped += 1;
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);

    if (docs.length >= MAX_DOC_SNAPSHOTS_PER_MESSAGE) {
      skipped += 1;
      continue;
    }

    // Self keys resolve back against `root`; cross keys already carry the
    // realpath'd file from the fenced lookup.
    const file = occ.kind === "cross" ? occ.file : await resolveWorkspaceFile(rootReal, key);
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
      docs.push({ path: key, sha256, size, content });
      totalBytes += size;
      snapshotted.add(key);
    } catch {
      skipped += 1;
    }
  }

  // Self snapshot keys are bare base-relative paths; a cross short form
  // `<ownerSlug>/<rel>` can therefore collide with one (e.g. the sender also
  // snapshotted a real file at `assistant/design.md`). Web gives a direct
  // self-key match priority, so a colliding short form would link to the WRONG
  // (self) snapshot. Detect the collision here and fall back to the FULL global
  // key for that cross mention so web direct-matches the right snapshot
  // (review P2-b).
  const selfKeys = new Set<string>();
  for (const occ of resolved) {
    if (occ.kind === "self" && occ.key && snapshotted.has(occ.key)) selfKeys.add(occ.key);
  }

  // Pass 3 — rewrite text spans to the form web re-scans into the snapshot key.
  // Web can't map an absolute path (it doesn't know `root`), nor a cross global
  // key from a bare absolute path, so:
  //   self + absolute-in-root → canonical bare relative path (unchanged #480)
  //   cross                   → short `<ownerSlug>/<rel>` (web re-expands with
  //                             chatId), OR the full global key when the short
  //                             form would collide with a self snapshot key.
  // Self RELATIVE mentions (`./docs/foo.md`) are left verbatim because web
  // already canonicalises them on re-scan. Only tokens that actually produced a
  // snapshot are rewritten, so "rewritten ⇔ previewable" holds.
  const rewrites: Array<{ start: number; end: number; replacement: string }> = [];
  for (const occ of resolved) {
    if (!occ.key || !snapshotted.has(occ.key)) continue;
    if (occ.kind === "self" && isAbsolute(occ.writtenPath)) {
      rewrites.push({ start: occ.start, end: occ.end, replacement: `${occ.key}${occ.lineSuffix}` });
    } else if (occ.kind === "cross") {
      const replacement = selfKeys.has(occ.shortForm) ? occ.key : occ.shortForm;
      rewrites.push({ start: occ.start, end: occ.end, replacement: `${replacement}${occ.lineSuffix}` });
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
 * Resolve an ABSOLUTE `.md` path that points into a DIFFERENT agent's
 * workspace under the shared common root. Returns the global snapshot key
 * `<ownerSlug>/<chatId>/<rel>`, the realpath'd file to read, and the short
 * `<ownerSlug>/<rel>` form to rewrite into the outbound text — or null when
 * the path is outside the common root, belongs to another chat, hides, is the
 * sender's own workspace (handled as a self path), is not a regular `.md`
 * file, or cannot be realpath'd.
 *
 * realpath runs BEFORE the containment check so an ancestor symlink cannot
 * fake "inside the common root" — same discipline as the self-path resolver.
 */
async function resolveCrossWorkspaceDoc(
  workspacesRootReal: string,
  fence: WorkspaceFence,
  absPath: string,
): Promise<{ key: string; file: string; shortForm: string } | null> {
  const real = await safeRealpath(absPath);
  if (!real) return null;

  const prefix = workspacesRootReal.endsWith(sep) ? workspacesRootReal : workspacesRootReal + sep;
  if (!real.startsWith(prefix)) return null;

  const segments = relative(workspacesRootReal, real)
    .split(sep)
    .filter((s) => s.length > 0 && s !== ".");
  // Need at least <ownerSlug>/<chatId>/<file>.
  if (segments.length < 3) return null;
  // Reject any hidden segment (`.agent/`, `.git/`, dotfiles) anywhere in the
  // realpath — closes the symlink-into-hidden-dir escape after realpath.
  if (segments.some((s) => s.startsWith("."))) return null;

  const [ownerSlug, segChatId, ...rest] = segments;
  if (!ownerSlug || !segChatId) return null;
  // Chat-scope fence: only the current chat's workspaces are in range, so one
  // chat can never preview another chat's private workspace docs.
  if (segChatId !== fence.chatId) return null;
  // The sender's own workspace is handled by the self-path resolver (bare key,
  // #480 rewrite). Keep cross strictly cross-agent.
  if (ownerSlug === fence.selfSlug) return null;

  const rel = rest.join("/");
  const key = buildWorkspaceDocKey(ownerSlug, segChatId, rel);
  if (!key || !key.toLowerCase().endsWith(".md")) return null;

  try {
    const st = await stat(real);
    if (!st.isFile()) return null;
  } catch {
    return null;
  }

  return { key, file: real, shortForm: `${ownerSlug}/${rel}` };
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
