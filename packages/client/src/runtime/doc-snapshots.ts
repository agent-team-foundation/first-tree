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
 * Resolution is constrained to `root` (+ the optional cross-agent fence). A
 * path resolves when its real target is a regular `.md` file physically inside
 * an allowed root with no hidden segment. Relative (`docs/foo.md`,
 * `./docs/foo.md`) and absolute-inside-root (`<root>/docs/foo.md`) forms both
 * resolve.
 *
 * For every resolved+snapshotted reference we **rewrite its span in the
 * outbound text into an EXPLICIT markdown link** whose href is the canonical
 * snapshot key — a bare mention becomes `[display](key)`, an inline
 * `[label](target)` keeps its label and points the target at the key. The
 * caller sends `rewrittenText`. Web then renders a native markdown link and
 * resolves a click by a direct href→snapshot lookup: it does NOT re-scan free
 * text, re-derive keys, or expand cross short-forms. That removes the whole
 * "the runtime scanner and the web scanner must agree" failure class (and the
 * cross-agent web-version skew it caused), and is immune to server-side body
 * rewrites (e.g. `@mention` prepend) since a `[..](..)` link survives wherever
 * it lands. Only snapshotted refs are rewritten, so "rewritten ⇔ has a
 * snapshot ⇔ web can render it" holds. (Web keeps a legacy bare-token re-scan
 * for messages authored before this — it is simply inert here because the
 * scanner skips inline links.)
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

/**
 * Self-fence config: the agent's own workspace root + an optional source-repo
 * `localPath` for relative-path promotion.
 *
 * Why two roots: after #506 the agent's cwd is the per-agent home and the
 * `git worktree add` workflow (#498) puts task-scoped checkouts at
 * `<agentHome>/worktrees/<task>/`. Those are **siblings** of the predeclared
 * source repo at `<agentHome>/<localPath>/`. Containment-checking absolute
 * paths against the source repo alone (the pre-#535 behaviour, restored by
 * #535 to the right root but not widened) drops every worktree mention back to
 * plain text. The fix is to gate absolute paths on the wider `agentHome`
 * boundary while keeping relative paths resolving against the source repo top
 * (where "docs/foo.md" has always meant "in the source repo").
 *
 * `singleRepoLocalPath`, when set, is used both to RESOLVE relative mentions
 * (against `<agentHome>/<localPath>`) AND to **promote** the resulting snapshot
 * key to `<localPath>/<rel>` so a file written two ways (relative
 * `docs/foo.md` and absolute `<agentHome>/<localPath>/docs/foo.md`) ends up
 * with one shared canonical key. Zero / multi-repo agents skip the promotion;
 * relative mentions resolve against `agentHome` directly.
 */
export type SelfFence = {
  /** Per-agent home (`acquireAgentHome` return value) or legacy per-chat dir
   *  for pre-#506 chats. Absolute paths must realpath inside this; snapshot
   *  keys are emitted relative to this root. */
  agentHome: string;
  /** Single declared source-repo `localPath` — e.g. `"first-tree"`. Set when
   *  `payload.gitRepos.length === 1` and its localPath is non-empty. */
  singleRepoLocalPath?: string;
};

type ResolvedRoots = {
  agentHomeReal: string;
  /** Where relative paths resolve. Equals `agentHomeReal` when no singleRepo
   *  localPath; equals `<agentHomeReal>/<localPath>` realpath'd otherwise. May
   *  fall back to `agentHomeReal` when the localPath dir doesn't yet exist. */
  docBaseReal: string;
  /** `<localPath>` as a POSIX-canonical key prefix (or null when no promotion).
   *  Used to promote a relative `docs/foo.md` into agent-home-relative form
   *  `<localPath>/docs/foo.md`. */
  promotePrefix: string | null;
};

type ResolvedOccurrence = DocPathOccurrence & {
  kind: "self" | "cross" | null;
  /** Snapshot key: agent-home-relative for self (key collisions with cross
   *  ruled out because cross keys are global `<slug>/<chatId>/<rel>`). */
  key: string | null;
  /** Realpath of the file to read (cross only; self resolves against
   *  `agentHomeReal`). */
  file: string | null;
  /** Rewrite replacement for a cross mention: short `<ownerSlug>/<rel>`. */
  shortForm: string;
};

export async function buildMessageDocumentSnapshots(
  text: string,
  self: string | SelfFence,
  fence?: WorkspaceFence,
): Promise<{ docs: SnapshotDoc[]; skipped: number; rewrittenText: string }> {
  const occurrences = collectDocPathOccurrences(text);
  if (occurrences.length === 0) return { docs: [], skipped: 0, rewrittenText: text };

  const selfConfig: SelfFence = typeof self === "string" ? { agentHome: self } : self;
  const roots = await resolveSelfRoots(selfConfig);
  if (!roots) return { docs: [], skipped: occurrences.length, rewrittenText: text };

  const workspacesRootReal = fence ? await safeRealpath(fence.workspacesRoot) : null;

  // Pass 1 — resolve every occurrence to a snapshot plan:
  //   self  → key relative to `agentHomeReal`; relative mentions in single-
  //           repo workspaces are PROMOTED to `<localPath>/<rel>` so the abs
  //           and rel forms of the same source-repo file share one canonical
  //           key.
  //   cross → global key `<ownerSlug>/<chatId>/<rel>` for a file that realpaths
  //           into ANOTHER agent's workspace under the shared common root.
  const resolved: ResolvedOccurrence[] = await Promise.all(
    occurrences.map(async (occ): Promise<ResolvedOccurrence> => {
      const selfKey = await canonicalizeWorkspacePath(roots, occ.writtenPath);
      if (selfKey) return { ...occ, kind: "self", key: selfKey, file: null, shortForm: "" };
      // Only an ABSOLUTE path can escape the sender's own home into a sibling
      // workspace; a relative mention always resolves under the self roots.
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

    // Self keys resolve back against `agentHomeReal`; cross keys already
    // carry the realpath'd file from the fenced lookup.
    const file = occ.kind === "cross" ? occ.file : await resolveWorkspaceFile(roots.agentHomeReal, key);
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

  // Pass 3 — rewrite every resolved+snapshotted reference into an EXPLICIT
  // markdown link whose href is the canonical snapshot key. Web then renders a
  // native link and resolves a click by a direct href→snapshot lookup; it no
  // longer re-scans free text or re-derives/expands keys. That removes the
  // "two scanners must agree" fragility — and, because the href carries the
  // FULL key (relative for self, global `<slug>/<chatId>/<rel>` for cross),
  // the cross-agent web-version skew is gone too (no chatId re-expansion on
  // the web side). The href being explicit also makes short-form/self-key
  // collisions impossible, so no collision handling is needed.
  //   - bare mention   → `[display](key)` (display = canonical relative for
  //                       self, short `<slug>/<rel>` for cross; `:line` kept on
  //                       the display, stripped from the key href).
  //   - inline `[label](target)` → target replaced with the key; the agent's
  //                       label is preserved.
  // Only tokens that actually produced a snapshot are rewritten, so the
  // invariant "rewritten ⇔ has a snapshot ⇔ web can render it" holds.
  const rewrites: Array<{ start: number; end: number; replacement: string }> = [];
  for (const occ of resolved) {
    if (!occ.key || !snapshotted.has(occ.key)) continue;
    if (occ.source === "inline") {
      // Point the agent's existing link at the canonical key (no-op when it
      // already is); the label between `[` and `]` is left untouched.
      rewrites.push({ start: occ.start, end: occ.end, replacement: occ.key });
    } else {
      const display = occ.kind === "cross" ? occ.shortForm : occ.key;
      rewrites.push({ start: occ.start, end: occ.end, replacement: `[${display}${occ.lineSuffix}](${occ.key})` });
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
  /**
   * `bare` — a plain `path.md` mention; rewritten into an explicit
   * `[display](key)` markdown link so web renders a native link (no re-scan).
   * `inline` — the `(target)` of an agent-authored `[label](target.md)`; only
   * the target is rewritten to the canonical key (the agent's label is kept).
   */
  source: "bare" | "inline";
};

function collectDocPathOccurrences(text: string): DocPathOccurrence[] {
  const out: DocPathOccurrence[] = [];
  for (const link of scanInlineMarkdownLinks(text)) {
    out.push({ writtenPath: link.target, lineSuffix: "", start: link.start, end: link.end, source: "inline" });
  }
  for (const m of scanBareDocPathTokens(text)) {
    const writtenPath = stripDocPathLineSuffix(m.raw);
    out.push({ writtenPath, lineSuffix: m.raw.slice(writtenPath.length), start: m.start, end: m.end, source: "bare" });
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
 * Realpath the two self roots up-front so every occurrence in `Pass 1` shares
 * the same containment-check fixtures. Returns null when `agentHome` itself is
 * unrealpath'able — there is no workspace to snapshot against, so every
 * occurrence is "skipped" by the caller.
 *
 * `docBaseReal` falls back to `agentHomeReal` when `singleRepoLocalPath` is
 * unset OR points to a directory that doesn't physically exist yet (e.g. the
 * source repo hasn't been materialised when the very first message goes out).
 * In both cases the promotion is silently dropped — relative mentions still
 * resolve, just against the agent home directly, matching the legacy
 * zero/multi-repo path.
 */
async function resolveSelfRoots(self: SelfFence): Promise<ResolvedRoots | null> {
  const agentHomeReal = await safeRealpath(self.agentHome);
  if (!agentHomeReal) return null;
  const localPath = self.singleRepoLocalPath?.trim();
  if (!localPath) {
    return { agentHomeReal, docBaseReal: agentHomeReal, promotePrefix: null };
  }
  const docBaseReal = await safeRealpath(resolve(agentHomeReal, localPath));
  if (!docBaseReal) {
    return { agentHomeReal, docBaseReal: agentHomeReal, promotePrefix: null };
  }
  // Defence in depth: the localPath dir must still be inside the agent home.
  // A misconfigured `localPath: "../escape"` would otherwise let the docBase
  // wander outside the fence and accept files we don't intend to snapshot.
  const prefix = agentHomeReal.endsWith(sep) ? agentHomeReal : agentHomeReal + sep;
  if (docBaseReal !== agentHomeReal && !docBaseReal.startsWith(prefix)) {
    return { agentHomeReal, docBaseReal: agentHomeReal, promotePrefix: null };
  }
  // Promote relative keys to `<localPath>/<rel>` so abs + rel forms of the
  // same source-repo file share one canonical key. `normalizeDocLinkPath`
  // canonicalises here too, so a stray leading "/" or "./" in the operator's
  // config doesn't leak through into snapshot keys.
  const promote = normalizeDocLinkPath(relative(agentHomeReal, docBaseReal));
  return {
    agentHomeReal,
    docBaseReal,
    promotePrefix: promote && promote.length > 0 ? promote : null,
  };
}

/**
 * Resolve the canonical agent-home-relative snapshot key for a written `.md`
 * path. Accepts BOTH relative paths (resolved against `docBaseReal` — the
 * source repo top for single-repo agents, the agent home otherwise) and
 * absolute paths (containment-checked against the wider `agentHomeReal` so
 * `<agentHome>/worktrees/<task>/foo.md` and `<agentHome>/<localPath>/docs/foo.md`
 * both land inside the fence).
 *
 * Absolute paths are `realpath`'d FIRST, then checked for containment — so an
 * ancestor symlink cannot be used to claim a path is "inside" the home when
 * its real target is not. The result is run back through `normalizeDocLinkPath`
 * so the key is POSIX-canonical and any hidden segment exposed by the realpath
 * (`<agentHome>/.agent/x.md` reached via a symlink) is rejected — matching
 * what web's re-scan derives from the rewritten token. Returns null when the
 * path escapes the home, hides, or cannot be realpath'd; the caller then leaves
 * the text untouched and embeds no snapshot.
 *
 * Relative paths get a second pass: `<docBaseReal>/<rel>` is realpath'd to
 * confirm the file physically exists inside the fence (so the snapshot key
 * agrees with what `resolveWorkspaceFile` will read) and to derive the
 * agent-home-relative form. A relative mention that points at a non-existent
 * file falls back to the un-promoted `normalizeDocLinkPath` so we don't change
 * pre-#535 behaviour for tokens that were always dropped anyway.
 */
async function canonicalizeWorkspacePath(roots: ResolvedRoots, writtenPath: string): Promise<string | null> {
  if (isAbsolute(writtenPath)) {
    const real = await safeRealpath(writtenPath);
    if (!real) return null;
    const prefix = roots.agentHomeReal.endsWith(sep) ? roots.agentHomeReal : roots.agentHomeReal + sep;
    if (real !== roots.agentHomeReal && !real.startsWith(prefix)) return null;
    return normalizeDocLinkPath(relative(roots.agentHomeReal, real));
  }

  // Relative path. Try to land it inside the fence so abs and rel forms agree
  // on the same key; if it can't be realpath'd, fall back to the bare
  // normalized form (legacy: caller's resolveWorkspaceFile will still drop it).
  const normalized = normalizeDocLinkPath(writtenPath);
  if (!normalized) return null;
  const real = await safeRealpath(resolve(roots.docBaseReal, normalized));
  if (!real) {
    // The file may not exist yet (or the path leaves the fence via `..`); the
    // pre-promotion key remains valid for the legacy single-root resolve in
    // resolveWorkspaceFile, where promotePrefix is null. With a promotePrefix
    // we still need agent-home-relative output, so synthesise it from the
    // normalized rel form.
    if (roots.promotePrefix) {
      return normalizeDocLinkPath(`${roots.promotePrefix}/${normalized}`);
    }
    return normalized;
  }
  const prefix = roots.agentHomeReal.endsWith(sep) ? roots.agentHomeReal : roots.agentHomeReal + sep;
  if (real !== roots.agentHomeReal && !real.startsWith(prefix)) return null;
  return normalizeDocLinkPath(relative(roots.agentHomeReal, real));
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
