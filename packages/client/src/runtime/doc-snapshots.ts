import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  type AttachmentRef,
  buildWorkspaceDocKey,
  type DocSnapshotFailReason,
  type FailedDocMention,
  MAX_ATTACHMENT_BYTES,
  MAX_FAILED_DOC_MENTION_RAW_LEN,
  MAX_FAILED_DOC_MENTIONS_PER_MESSAGE,
  MAX_MESSAGE_ATTACHMENT_REFS,
  normalizeDocLinkPath,
  scanBareDocPathTokens,
  stripDocPathLineSuffix,
} from "@first-tree/shared";

/**
 * Per-file raw byte cap for a doc capture, aligned with the attachment UPLOAD
 * cap (10MB) rather than a separate, smaller capture ceiling. A doc up to the
 * upload limit is captured and uploaded; the preview drawer enforces its own
 * far-smaller render cap (~1MB) and falls back to an authenticated download for
 * anything larger, so a huge markdown never chokes the UI. Files above the
 * upload cap hit `too-large` and stay plain text (the blob store would reject
 * the upload anyway).
 */
const MAX_DOC_CAPTURE_BYTES = MAX_ATTACHMENT_BYTES;
/** MIME the runtime assigns to markdown doc captures. */
const DOC_CAPTURE_MIME = "text/markdown";
/** Bounded retries for a single doc upload before giving up and degrading the
 *  mention to plain text. */
const DOC_UPLOAD_MAX_ATTEMPTS = 3;

/**
 * Minimal upload surface this module needs — a slice of the SDK so unit tests
 * can stub it without constructing a full SDK. Mirrors `sdk.uploadAttachment`.
 */
export type AttachmentUploader = {
  uploadAttachment(opts: {
    bytes: Uint8Array | Buffer;
    mimeType: string;
    filename: string;
    orgId: string;
  }): Promise<{ id: string; mimeType: string; filename: string; sizeBytes: number }>;
};

/**
 * Scan an outbound agent message for `.md` path mentions (inline markdown
 * links `[text](path.md)` AND bare `path.md` tokens), upload each
 * safely-resolvable target's bytes to the org attachment store, and turn the
 * mention into a clickable preview link that points at the stored blob.
 *
 * Resolution is constrained to `root` (+ the optional cross-agent fence) — the
 * same provenance fence as before: a path resolves when its real target is a
 * regular `.md` file physically inside an allowed root with no hidden segment.
 * Relative (`docs/foo.md`, `./docs/foo.md`) and absolute-inside-root forms both
 * resolve. The fence is the send-side authz: the sender can only capture docs
 * it can legitimately read.
 *
 * For every resolved file we:
 *  1. read the bytes and compute `sha256` (stored in the ref for renderer-side
 *     end-to-end integrity verification),
 *  2. upload to `POST /orgs/:orgId/attachments` (bounded retry) to get an
 *     `attachmentId`,
 *  3. build a generic `AttachmentRef{ kind: "document", attachmentId, ... }`
 *     mounted at `metadata.attachments[]`, and
 *  4. rewrite the mention's span into an explicit `[display](attachment:<id>)`
 *     markdown link.
 *
 * The rewrite happens **only after a successful upload**, so the invariant
 * "rewritten ⇔ has a ref ⇔ web can fetch+render it" holds. A failed upload
 * (after the bounded retry) leaves the mention as plain text and does NOT
 * block message delivery. Bare-source resolution failures are reported via
 * `failedMentions[]` so web can render an inert chip; inline `[label](target)`
 * failures stay silent (the agent's link still renders, the click handler
 * no-ops on a missing ref).
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
 * `localPath` for relative-path promotion. See git history / proposal §5.1 for
 * the two-root rationale (agent home vs source-repo top).
 */
export type SelfFence = {
  agentHome: string;
  singleRepoLocalPath?: string;
};

/** Exported for reuse by the sibling image-capture builder (`image-snapshots.ts`),
 *  which resolves outbound image mentions against the exact same self-fence. */
export type ResolvedRoots = {
  agentHomeReal: string;
  docBaseReal: string;
  promotePrefix: string | null;
};

type ResolvedOccurrence = DocPathOccurrence & {
  kind: "self" | "cross" | null;
  /** Canonical workspace-relative source path: agent-home-relative for self,
   *  short `<ownerSlug>/<rel>` for cross. Stored in `ref.source.path`. */
  sourcePath: string | null;
  /** Realpath of the file to read. */
  file: string | null;
  failReason?: DocSnapshotFailReason;
};

export type BuildDocAttachmentsOptions = {
  uploader: AttachmentUploader;
  orgId: string;
  /** Caller-specific share of the per-message attachment budget. */
  maxAttachments?: number;
};

export async function buildMessageDocumentSnapshots(
  text: string,
  self: string | SelfFence,
  opts: BuildDocAttachmentsOptions,
  fence?: WorkspaceFence,
): Promise<{
  refs: AttachmentRef[];
  skipped: number;
  rewrittenText: string;
  /**
   * Per-mention failures (BARE-source tokens only, deduped by writtenPath).
   * Caller embeds this as `metadata.documentContext.failedMentions` so web can
   * render an inert "doc chip" at the original token position.
   */
  failedMentions: FailedDocMention[];
}> {
  const occurrences = collectDocPathOccurrences(text);
  const empty = {
    refs: [] as AttachmentRef[],
    skipped: 0,
    rewrittenText: text,
    failedMentions: [] as FailedDocMention[],
  };
  if (occurrences.length === 0) return empty;

  const selfConfig: SelfFence = typeof self === "string" ? { agentHome: self } : self;
  const roots = await resolveSelfRoots(selfConfig);
  if (!roots) return { ...empty, skipped: occurrences.length };

  const workspacesRootReal = fence ? await safeRealpath(fence.workspacesRoot) : null;
  const requestedLimit = opts.maxAttachments;
  const attachmentLimit =
    requestedLimit === undefined || !Number.isFinite(requestedLimit)
      ? MAX_MESSAGE_ATTACHMENT_REFS
      : Math.min(MAX_MESSAGE_ATTACHMENT_REFS, Math.max(0, Math.trunc(requestedLimit)));

  // Pass 1 — resolve every occurrence to a readable file + canonical source
  // path, or attach a failure reason. Same provenance fence as before.
  const resolved: ResolvedOccurrence[] = await Promise.all(
    occurrences.map(async (occ): Promise<ResolvedOccurrence> => {
      const selfKey = await canonicalizeWorkspacePath(roots, occ.writtenPath);
      if (selfKey) {
        const file = await resolveWorkspaceFile(roots.agentHomeReal, selfKey);
        if (file) return { ...occ, kind: "self", sourcePath: selfKey, file };
        // Canonicalised but unreadable (race / non-file) — classify below.
      }
      if (workspacesRootReal && fence && isAbsolute(occ.writtenPath)) {
        const cross = await resolveCrossWorkspaceDoc(workspacesRootReal, fence, occ.writtenPath);
        if (cross) return { ...occ, kind: "cross", sourcePath: cross.shortForm, file: cross.file };
      }
      const failReason = await classifyOccurrenceFailure(occ, roots, fence, workspacesRootReal);
      return { ...occ, kind: null, sourcePath: null, file: null, failReason };
    }),
  );

  // Pass 2 — read + upload. De-dupe by source path so the same file mentioned
  // twice is uploaded once; both occurrences then rewrite to the same ref.
  const refsByPath = new Map<string, AttachmentRef>();
  let skipped = 0;
  const attempted = new Set<string>();

  // Upload eligible files in parallel.
  const uploadTasks: Array<Promise<void>> = [];
  for (const occ of resolved) {
    const sourcePath = occ.sourcePath;
    const file = occ.file;
    if (!sourcePath || !file || !sourcePath.toLowerCase().endsWith(".md")) {
      if (occ.failReason === undefined && occ.kind === null) occ.failReason = "missing";
      continue;
    }
    if (attempted.has(sourcePath)) continue;
    attempted.add(sourcePath);

    if (refsByPath.size + uploadTasks.length >= attachmentLimit) {
      occ.failReason = "budget-exceeded";
      skipped += 1;
      continue;
    }

    uploadTasks.push(
      (async () => {
        const captured = await captureAndUpload(file, sourcePath, opts);
        if (captured.ref) {
          refsByPath.set(sourcePath, captured.ref);
        } else {
          skipped += 1;
          // Attach the reason to every occurrence of this path (Pass 3 reads it).
          for (const o of resolved) {
            if (o.sourcePath === sourcePath) o.failReason = captured.reason;
          }
        }
      })(),
    );
  }
  await Promise.all(uploadTasks);

  // Pass 3 — rewrite every occurrence whose path produced a ref into an
  // explicit `[display](attachment:<id>)` link (bare) or retarget the inline
  // link's `(target)` (inline). Only refs that uploaded successfully rewrite.
  const rewrites: Array<{ start: number; end: number; replacement: string }> = [];
  for (const occ of resolved) {
    const sourcePath = occ.sourcePath;
    if (!sourcePath) continue;
    const ref = refsByPath.get(sourcePath);
    if (!ref) continue;
    const href = attachmentHref(ref.attachmentId);
    if (occ.source === "inline") {
      rewrites.push({ start: occ.start, end: occ.end, replacement: href });
    } else if (occ.enclosingCodeSpan) {
      const visibleText = text.slice(occ.enclosingCodeSpan.start, occ.enclosingCodeSpan.end);
      rewrites.push({
        start: occ.enclosingCodeSpan.start,
        end: occ.enclosingCodeSpan.end,
        replacement: `[${visibleText}](${href})`,
      });
    } else {
      const display = `${sourcePath}${occ.lineSuffix}`;
      rewrites.push({ start: occ.start, end: occ.end, replacement: `[${display}](${href})` });
    }
  }

  // Collect per-mention failures (bare-source only), deduped by writtenPath.
  const failuresByRaw = new Map<string, DocSnapshotFailReason>();
  for (const occ of resolved) {
    if (occ.source !== "bare") continue;
    if (!occ.failReason) continue;
    const raw = occ.writtenPath;
    if (!raw || raw.length > MAX_FAILED_DOC_MENTION_RAW_LEN) continue;
    if (failuresByRaw.has(raw)) continue;
    if (failuresByRaw.size >= MAX_FAILED_DOC_MENTIONS_PER_MESSAGE) break;
    failuresByRaw.set(raw, occ.failReason);
  }
  const failedMentions: FailedDocMention[] = [...failuresByRaw.entries()].map(([raw, reason]) => ({ raw, reason }));

  return {
    refs: [...refsByPath.values()],
    skipped,
    rewrittenText: applyRewrites(text, rewrites),
    failedMentions,
  };
}

/** Scheme used to point a rewritten doc mention at its stored attachment. The
 *  web link layer parses this back into the attachmentId. */
const ATTACHMENT_HREF_SCHEME = "attachment:";

export function attachmentHref(attachmentId: string): string {
  return `${ATTACHMENT_HREF_SCHEME}${attachmentId}`;
}

/**
 * Read a file, enforce the capture byte cap, compute sha256, and upload to the
 * attachment store with a bounded retry. Returns the built `AttachmentRef` or a
 * failure reason. Never throws — upload/IO failures degrade to plain text.
 */
async function captureAndUpload(
  file: string,
  sourcePath: string,
  opts: BuildDocAttachmentsOptions,
): Promise<{ ref: AttachmentRef; reason?: undefined } | { ref: null; reason: DocSnapshotFailReason }> {
  let content: string;
  let size: number;
  try {
    const buf = await readFile(file);
    if (buf.byteLength > MAX_DOC_CAPTURE_BYTES) return { ref: null, reason: "too-large" };
    content = buf.toString("utf8");
    // Re-encode so `size` matches what the server measures from the uploaded
    // bytes (invalid UTF-8 → U+FFFD substitution can change byte length).
    size = Buffer.byteLength(content, "utf8");
    if (size > MAX_DOC_CAPTURE_BYTES) return { ref: null, reason: "too-large" };
  } catch {
    return { ref: null, reason: "unreadable" };
  }

  const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
  const filename = sourcePath.split("/").filter(Boolean).at(-1) ?? "document.md";
  // Upload the re-encoded bytes (not the raw buffer) so the stored byte length
  // matches `size` and `sha256` exactly.
  const bytes = Buffer.from(content, "utf8");

  let lastError: unknown;
  for (let attempt = 1; attempt <= DOC_UPLOAD_MAX_ATTEMPTS; attempt += 1) {
    try {
      const uploaded = await opts.uploader.uploadAttachment({
        bytes,
        mimeType: DOC_CAPTURE_MIME,
        filename,
        orgId: opts.orgId,
      });
      const ref: AttachmentRef = {
        attachmentId: uploaded.id,
        kind: "document",
        mimeType: DOC_CAPTURE_MIME,
        filename,
        size,
        sha256,
        source: { path: sourcePath },
      };
      return { ref };
    } catch (err) {
      lastError = err;
    }
  }
  void lastError;
  // Bounded retry exhausted — degrade to plain text. `unreadable` is the
  // closest existing inert-chip bucket for "couldn't materialise the preview".
  return { ref: null, reason: "unreadable" };
}

/**
 * Best-effort classification of why a doc mention failed to resolve to a
 * readable workspace file. Runs ONLY on occurrences that fell through Pass 1.
 */
async function classifyOccurrenceFailure(
  occ: DocPathOccurrence,
  roots: ResolvedRoots,
  fence: WorkspaceFence | undefined,
  workspacesRootReal: string | null,
): Promise<DocSnapshotFailReason> {
  const writtenSegs = occ.writtenPath.split(/[\\/]+/).filter((s) => s.length > 0 && s !== "." && s !== "..");
  if (writtenSegs.some((s) => s.startsWith("."))) return "hidden-segment";

  let real: string | null = null;
  if (isAbsolute(occ.writtenPath)) {
    real = await safeRealpath(occ.writtenPath);
  } else {
    const normalized = normalizeDocLinkPath(occ.writtenPath);
    if (!normalized) return "out-of-fence";
    real = await safeRealpath(resolve(roots.docBaseReal, normalized));
  }
  if (!real) return "missing";

  const homeRel = relative(roots.agentHomeReal, real)
    .split(sep)
    .filter((s) => s.length > 0 && s !== "." && s !== "..");
  if (homeRel.some((s) => s.startsWith("."))) return "hidden-segment";

  const homePrefix = roots.agentHomeReal.endsWith(sep) ? roots.agentHomeReal : roots.agentHomeReal + sep;
  const insideHome = real === roots.agentHomeReal || real.startsWith(homePrefix);
  if (!insideHome) {
    if (workspacesRootReal && fence) {
      const wsPrefix = workspacesRootReal.endsWith(sep) ? workspacesRootReal : workspacesRootReal + sep;
      if (real.startsWith(wsPrefix)) {
        const wsRel = relative(workspacesRootReal, real)
          .split(sep)
          .filter((s) => s.length > 0 && s !== "." && s !== "..");
        if (wsRel.some((s) => s.startsWith("."))) return "hidden-segment";
        if (wsRel.length < 3) return "out-of-fence";
        const [ownerSlug, segChatId] = wsRel;
        if (segChatId !== fence.chatId) return "out-of-fence";
        if (ownerSlug === fence.selfSlug) return "missing";
        try {
          const st = await stat(real);
          if (!st.isFile()) return "missing";
        } catch {
          return "missing";
        }
        return "unreadable";
      }
    }
    return "out-of-fence";
  }

  try {
    const st = await stat(real);
    if (!st.isFile()) return "missing";
  } catch {
    return "missing";
  }
  return "unreadable";
}

type DocPathOccurrence = {
  writtenPath: string;
  lineSuffix: string;
  start: number;
  end: number;
  source: "bare" | "inline";
  enclosingCodeSpan?: { start: number; end: number };
};

function collectDocPathOccurrences(text: string): DocPathOccurrence[] {
  const out: DocPathOccurrence[] = [];
  for (const link of scanInlineMarkdownLinks(text)) {
    out.push({ writtenPath: link.target, lineSuffix: "", start: link.start, end: link.end, source: "inline" });
  }
  for (const m of scanBareDocPathTokens(text)) {
    const writtenPath = stripDocPathLineSuffix(m.raw);
    const entry: DocPathOccurrence = {
      writtenPath,
      lineSuffix: m.raw.slice(writtenPath.length),
      start: m.start,
      end: m.end,
      source: "bare",
    };
    if (m.enclosingCodeSpan) entry.enclosingCodeSpan = m.enclosingCodeSpan;
    out.push(entry);
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

export async function resolveSelfRoots(self: SelfFence): Promise<ResolvedRoots | null> {
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
  const prefix = agentHomeReal.endsWith(sep) ? agentHomeReal : agentHomeReal + sep;
  if (docBaseReal !== agentHomeReal && !docBaseReal.startsWith(prefix)) {
    return { agentHomeReal, docBaseReal: agentHomeReal, promotePrefix: null };
  }
  const promote = normalizeDocLinkPath(relative(agentHomeReal, docBaseReal));
  return {
    agentHomeReal,
    docBaseReal,
    promotePrefix: promote && promote.length > 0 ? promote : null,
  };
}

export async function canonicalizeWorkspacePath(roots: ResolvedRoots, writtenPath: string): Promise<string | null> {
  if (isAbsolute(writtenPath)) {
    const real = await safeRealpath(writtenPath);
    if (!real) return null;
    const prefix = roots.agentHomeReal.endsWith(sep) ? roots.agentHomeReal : roots.agentHomeReal + sep;
    if (real !== roots.agentHomeReal && !real.startsWith(prefix)) return null;
    return normalizeDocLinkPath(relative(roots.agentHomeReal, real));
  }

  const normalized = normalizeDocLinkPath(writtenPath);
  if (!normalized) return null;
  const real = await safeRealpath(resolve(roots.docBaseReal, normalized));
  if (!real) {
    if (roots.promotePrefix) {
      return normalizeDocLinkPath(`${roots.promotePrefix}/${normalized}`);
    }
    return normalized;
  }
  const prefix = roots.agentHomeReal.endsWith(sep) ? roots.agentHomeReal : roots.agentHomeReal + sep;
  if (real !== roots.agentHomeReal && !real.startsWith(prefix)) return null;
  return normalizeDocLinkPath(relative(roots.agentHomeReal, real));
}

async function resolveCrossWorkspaceDoc(
  workspacesRootReal: string,
  fence: WorkspaceFence,
  absPath: string,
): Promise<{ file: string; shortForm: string } | null> {
  const real = await safeRealpath(absPath);
  if (!real) return null;

  const prefix = workspacesRootReal.endsWith(sep) ? workspacesRootReal : workspacesRootReal + sep;
  if (!real.startsWith(prefix)) return null;

  const segments = relative(workspacesRootReal, real)
    .split(sep)
    .filter((s) => s.length > 0 && s !== ".");
  if (segments.length < 3) return null;
  if (segments.some((s) => s.startsWith("."))) return null;

  const [ownerSlug, segChatId, ...rest] = segments;
  if (!ownerSlug || !segChatId) return null;
  if (segChatId !== fence.chatId) return null;
  if (ownerSlug === fence.selfSlug) return null;

  const rel = rest.join("/");
  // Validate the rel forms a canonical `.md` key (defence in depth).
  const key = buildWorkspaceDocKey(ownerSlug, segChatId, rel);
  if (!key || !key.toLowerCase().endsWith(".md")) return null;

  try {
    const st = await stat(real);
    if (!st.isFile()) return null;
  } catch {
    return null;
  }

  return { file: real, shortForm: `${ownerSlug}/${rel}` };
}

export async function resolveWorkspaceFile(rootReal: string, canonicalPath: string): Promise<string | null> {
  if (!canonicalPath || isAbsolute(canonicalPath)) return null;

  const candidate = resolve(rootReal, canonicalPath);
  const candidateReal = await safeRealpath(candidate);
  if (!candidateReal) return null;

  const prefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  if (candidateReal !== rootReal && !candidateReal.startsWith(prefix)) return null;

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
