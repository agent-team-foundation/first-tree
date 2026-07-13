import { readFile, stat } from "node:fs/promises";
import {
  fencedCodeBlockRanges,
  IMAGE_MIME_TO_EXT,
  type ImageRefContent,
  MAX_ATTACHMENT_BYTES,
  MAX_BATCH_ATTACHMENTS,
  type SupportedImageMime,
} from "@first-tree/shared";
import {
  type AttachmentUploader,
  canonicalizeWorkspacePath,
  resolveSelfRoots,
  resolveWorkspaceFile,
  type SelfFence,
} from "./doc-snapshots.js";

/**
 * Outbound image capture — the picture sibling of `doc-snapshots.ts`.
 *
 * When an agent's `chat send` body contains a markdown image `![alt](path)`
 * whose target is a local image file inside the sender's own workspace fence,
 * we upload the bytes to the org attachment store and hand the caller an
 * `ImageRefContent` (the exact shape a human image send produces). The caller
 * then converts the message to a `format: "file"` batch: caption = the body
 * with the captured image spans stripped, `attachments` = these refs. Web then
 * renders it identically to a human image send (caption on top, thumbnails
 * below) — zero web/server change.
 *
 * Scope (see the paired design note): we deliberately capture ONLY markdown
 * image syntax (an explicit "show this picture" intent, unlike a bare filename
 * mention) and ONLY the sender's own workspace (self-fence; cross-agent image
 * references are not a real use case). Capture never throws and never blocks a
 * send — a failed resolve/upload leaves the mention untouched in the caption.
 */

/** Reverse of `IMAGE_MIME_TO_EXT` — lowercased file extension → canonical MIME.
 *  `jpeg` and `jpg` both map to `image/jpeg`. */
const EXT_TO_IMAGE_MIME: Record<string, SupportedImageMime> = (() => {
  const map: Record<string, SupportedImageMime> = {};
  for (const [mime, ext] of Object.entries(IMAGE_MIME_TO_EXT) as [SupportedImageMime, string][]) {
    map[ext] = mime;
  }
  map.jpeg = "image/jpeg";
  return map;
})();

/** Bounded upload retries before giving up on one image (parity with the doc
 *  sibling's `DOC_UPLOAD_MAX_ATTEMPTS`). */
const IMAGE_UPLOAD_MAX_ATTEMPTS = 3;

type ImageOccurrence = {
  writtenPath: string;
  /** Span of the whole `![alt](path)` in the source text (for stripping). */
  start: number;
  end: number;
};

export type BuildImageAttachmentsOptions = {
  uploader: AttachmentUploader;
  orgId: string;
};

export type BuildMessageImageSnapshotsResult = {
  /** Image refs to carry as the `format: "file"` batch `attachments` (empty ⇒
   *  caller sends the message unchanged). Order follows first appearance. */
  imageRefs: ImageRefContent[];
  /** `text` with every captured image span removed and the leftover blank
   *  lines collapsed — becomes the batch `caption`. */
  strippedText: string;
  /** Count of image mentions that resolved in-fence but could not be captured
   *  (unreadable / too large / upload failed / over the batch cap). */
  skipped: number;
};

/**
 * Scan `text` for markdown image mentions, capture the in-fence ones, and
 * return the refs + the caption (text with captured spans stripped). A pure
 * pass-through (empty refs, unchanged text) when nothing resolves.
 */
export async function buildMessageImageSnapshots(
  text: string,
  self: string | SelfFence,
  opts: BuildImageAttachmentsOptions,
): Promise<BuildMessageImageSnapshotsResult> {
  const occurrences = collectImageOccurrences(text);
  if (occurrences.length === 0) return { imageRefs: [], strippedText: text, skipped: 0 };

  const selfConfig: SelfFence = typeof self === "string" ? { agentHome: self } : self;
  const roots = await resolveSelfRoots(selfConfig);
  if (!roots) return { imageRefs: [], strippedText: text, skipped: occurrences.length };

  // Pass 1 — resolve each mention to a readable in-fence file + its MIME.
  type Resolved = ImageOccurrence & { file: string; mime: SupportedImageMime };
  const resolvedList: Array<Resolved | null> = await Promise.all(
    occurrences.map(async (occ): Promise<Resolved | null> => {
      const mime = imageMimeForPath(occ.writtenPath);
      if (!mime) return null;
      const key = await canonicalizeWorkspacePath(roots, occ.writtenPath);
      if (!key) return null;
      const file = await resolveWorkspaceFile(roots.agentHomeReal, key);
      if (!file) return null;
      return { ...occ, file, mime };
    }),
  );

  // Pass 2 — read + upload, de-duped by resolved file so the same picture
  // referenced twice uploads once. Enforce the per-message batch cap.
  const refByFile = new Map<string, ImageRefContent>();
  let skipped = 0;

  const attempted = new Set<string>();
  const uploadTasks: Array<Promise<void>> = [];
  for (const occ of resolvedList) {
    if (!occ) continue;
    if (attempted.has(occ.file)) continue;
    attempted.add(occ.file);
    if (attempted.size > MAX_BATCH_ATTACHMENTS) {
      skipped += 1;
      continue;
    }
    uploadTasks.push(
      (async () => {
        const ref = await captureAndUpload(occ.file, occ.writtenPath, occ.mime, opts);
        if (ref) refByFile.set(occ.file, ref);
        else skipped += 1;
      })(),
    );
  }
  await Promise.all(uploadTasks);
  if (refByFile.size === 0) return { imageRefs: [], strippedText: text, skipped };

  // Pass 3 — collect the refs (first-appearance order, de-duped) and strip the
  // spans. We strip EVERY in-fence-resolved image span, not only the captured
  // ones: because at least one image captured, the message flips to a `file`
  // batch whose caption is this text, and a leftover `![alt](local/path)` would
  // render as a broken `<img>` there. Out-of-fence mentions (unresolved) are
  // left untouched — we can't upload what we can't read.
  const seen = new Set<string>();
  const imageRefs: ImageRefContent[] = [];
  const resolvedSpans: Array<{ start: number; end: number }> = [];
  for (const occ of resolvedList) {
    if (!occ) continue;
    resolvedSpans.push({ start: occ.start, end: occ.end });
    const ref = refByFile.get(occ.file);
    if (ref && !seen.has(occ.file)) {
      seen.add(occ.file);
      imageRefs.push(ref);
    }
  }

  return { imageRefs, strippedText: stripSpans(text, resolvedSpans), skipped };
}

/** Read the file, enforce the upload cap, and upload. Returns the ref, or null
 *  on any IO/size/upload failure (caller degrades to leaving the mention). */
async function captureAndUpload(
  file: string,
  writtenPath: string,
  mime: SupportedImageMime,
  opts: BuildImageAttachmentsOptions,
): Promise<ImageRefContent | null> {
  // Enforce the size cap from `stat` BEFORE reading, so a huge (or sparse)
  // `.png` can't make us allocate its bytes into memory (up to 20 files upload
  // concurrently — reading first would risk an OOM before the size check).
  let bytes: Buffer;
  try {
    const st = await stat(file);
    if (st.size === 0 || st.size > MAX_ATTACHMENT_BYTES) return null;
    bytes = await readFile(file);
  } catch {
    return null;
  }
  // Re-check post-read against a race (file grown between stat and read).
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES) return null;

  const filename = basename(writtenPath);
  // Bounded retry, matching the doc sibling's `DOC_UPLOAD_MAX_ATTEMPTS`: a
  // single transient blob-store blip should not silently drop the image.
  for (let attempt = 1; attempt <= IMAGE_UPLOAD_MAX_ATTEMPTS; attempt += 1) {
    try {
      const uploaded = await opts.uploader.uploadAttachment({ bytes, mimeType: mime, filename, orgId: opts.orgId });
      return { imageId: uploaded.id, mimeType: mime, filename, size: bytes.byteLength };
    } catch {
      // try again until the attempt budget is exhausted
    }
  }
  return null;
}

/** Canonical image MIME for a path's extension, or null when the extension is
 *  not a supported image type (so http URLs / non-images never match). */
function imageMimeForPath(writtenPath: string): SupportedImageMime | null {
  const dot = writtenPath.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = writtenPath.slice(dot + 1).toLowerCase();
  return EXT_TO_IMAGE_MIME[ext] ?? null;
}

function basename(p: string): string {
  const segs = p.split(/[\\/]+/).filter(Boolean);
  return segs.at(-1) ?? "image";
}

/**
 * Collect markdown image mentions `![alt](path)` whose target is a local,
 * image-extension path. A leading `!` is required (that is what distinguishes an
 * image from a doc link); a `\` before the `!` escapes it, and any URL-scheme
 * target (`http://`, `data:`) is skipped — those already render inline and are
 * not workspace files. Mentions inside fenced (``` ```) or inline (`` ` ``) code
 * are skipped too: there the agent is SHOWING the markdown, not embedding an
 * image, and capturing would destructively strip a code sample.
 */
function collectImageOccurrences(text: string): ImageOccurrence[] {
  const out: ImageOccurrence[] = [];
  const codeRanges = codeSpanRanges(text);
  // BOUNDED quantifiers keep this linear: without a length cap, `[^\]\n]*`
  // rescans to end-of-input at every `![` start, so a pathological `![![![…`
  // body is O(n²) (CodeQL polynomial-ReDoS). Alt text ≤512 and path ≤2048 are
  // far beyond any real image mention and cap the per-attempt work.
  const re = /!\[[^\]\n]{0,512}\]\(([^\s)"]{1,2048})(?:\s+"[^"]*")?\)/g;
  let match: RegExpExecArray | null = re.exec(text);
  while (match !== null) {
    const whole = match[0];
    const target = match[1];
    const start = match.index;
    const prev = start > 0 ? text[start - 1] : "";
    if (prev !== "\\" && target && !hasUrlScheme(target) && !isInsideRange(start, codeRanges)) {
      out.push({ writtenPath: target, start, end: start + whole.length });
    }
    match = re.exec(text);
  }
  return out;
}

/** Byte ranges covered by fenced code blocks and inline code spans, so an image
 *  mention inside a code sample is skipped. Fenced blocks use the shared
 *  CommonMark scanner (`fencedCodeBlockRanges` — handles a longer closing fence
 *  and an unclosed fence extending to EOF); single-line inline spans are added
 *  when not already inside a fence. */
function codeSpanRanges(text: string): Array<{ start: number; end: number }> {
  const ranges = fencedCodeBlockRanges(text);
  const inline = /`[^`\n]*`/g;
  let m: RegExpExecArray | null = inline.exec(text);
  while (m !== null) {
    const start = m.index;
    if (!isInsideRange(start, ranges)) ranges.push({ start, end: start + m[0].length });
    m = inline.exec(text);
  }
  return ranges;
}

function isInsideRange(pos: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((r) => pos >= r.start && pos < r.end);
}

/** True for an absolute URL scheme (`http:`, `https:`, `data:`, …). A Windows
 *  drive prefix like `C:` is not treated as a scheme (single-letter). */
function hasUrlScheme(target: string): boolean {
  return /^[a-z][a-z0-9+.-]+:/i.test(target);
}

/** Remove `[start,end)` spans from `text`, then collapse the runs of blank
 *  lines a removed inline image can leave behind (3+ newlines → 2). */
function stripSpans(text: string, spans: Array<{ start: number; end: number }>): string {
  if (spans.length === 0) return text;
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const span of ordered) {
    if (span.start < cursor) continue;
    out += text.slice(cursor, span.start);
    cursor = span.end;
  }
  out += text.slice(cursor);
  return out.replace(/\n[ \t]*\n[ \t]*\n+/g, "\n\n").trim();
}
