import { readFile, stat } from "node:fs/promises";
import {
  IMAGE_MIME_TO_EXT,
  type ImageRefContent,
  MAX_ATTACHMENT_BYTES,
  MAX_BATCH_ATTACHMENTS,
  type SupportedImageMime,
} from "@first-tree/shared";
import { fromMarkdown } from "mdast-util-from-markdown";
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
 * When an agent's `chat send` body contains a markdown image `![alt](path)` or
 * `![alt](<path>)` whose target is a local image file inside the sender's own
 * workspace fence, we upload the bytes to the org attachment store and hand
 * the caller an `ImageRefContent` (the exact shape a human image send
 * produces). The caller then converts the message to a `format: "file"` batch:
 * caption = the body with the captured image spans stripped, `attachments` =
 * these refs. Web then renders it identically to a human image send (caption on
 * top, thumbnails below) — zero web/server change.
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
  /** Supported image MIME derived from the target's extension. Only supported
   *  image targets become occurrences, so the cap is over eligible images. */
  mime: SupportedImageMime;
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

  // Distinct supported-image paths in first-appearance order (occurrences are
  // already filtered to supported images). Cap the number we RESOLVE to the
  // batch limit BEFORE touching the filesystem, so a message with thousands of
  // mentions cannot fan out into thousands of concurrent realpath/stat calls —
  // the resolve/upload fan-out is bounded by MAX_BATCH_ATTACHMENTS. Distinct
  // paths beyond the cap are skipped and their mentions dropped from the caption
  // (below) rather than left as a broken local path.
  const distinctPaths: Array<{ path: string; mime: SupportedImageMime }> = [];
  const seenPath = new Set<string>();
  for (const occ of occurrences) {
    if (seenPath.has(occ.writtenPath)) continue;
    seenPath.add(occ.writtenPath);
    distinctPaths.push({ path: occ.writtenPath, mime: occ.mime });
  }
  const inCapPaths = distinctPaths.slice(0, MAX_BATCH_ATTACHMENTS);
  let skipped = distinctPaths.length - inCapPaths.length;

  // Pass 1 — resolve each in-cap distinct path to a readable in-fence file
  // (bounded fan-out ≤ MAX_BATCH_ATTACHMENTS).
  const resolvedByPath = new Map<string, { file: string; mime: SupportedImageMime }>();
  await Promise.all(
    inCapPaths.map(async ({ path, mime }) => {
      const key = await canonicalizeWorkspacePath(roots, path);
      if (!key) return;
      const file = await resolveWorkspaceFile(roots.agentHomeReal, key);
      if (!file) return;
      resolvedByPath.set(path, { file, mime });
    }),
  );

  // Pass 2 — upload each distinct resolved FILE once (two paths resolving to the
  // same realpath upload once).
  const refByFile = new Map<string, ImageRefContent | null>();
  const toUpload: Array<{ file: string; wp: string; mime: SupportedImageMime }> = [];
  for (const [wp, r] of resolvedByPath) {
    if (refByFile.has(r.file)) continue;
    refByFile.set(r.file, null);
    toUpload.push({ file: r.file, wp, mime: r.mime });
  }
  await Promise.all(
    toUpload.map(async (r) => {
      const ref = await captureAndUpload(r.file, r.wp, r.mime, opts);
      refByFile.set(r.file, ref);
      if (!ref) skipped += 1;
    }),
  );
  if (![...refByFile.values()].some((ref) => ref !== null)) {
    return { imageRefs: [], strippedText: text, skipped };
  }

  // Pass 3 — collect the refs (first-appearance order, de-duped by file) and
  // strip the caption. Because at least one image captured, the message flips
  // to a `file` batch whose caption is this text — so EVERY local-path image
  // candidate span is stripped, not just the captured ones: a captured mention
  // became an attachment, and an uncaptured or over-cap one would otherwise be
  // left as a `![alt](local/path)` that renders broken in the caption.
  // (Candidates already exclude web-URL images and code-block samples, which
  // stay.)
  const seenFile = new Set<string>();
  const imageRefs: ImageRefContent[] = [];
  const spans: Array<{ start: number; end: number }> = [];
  for (const occ of occurrences) {
    spans.push({ start: occ.start, end: occ.end });
    const r = resolvedByPath.get(occ.writtenPath);
    if (!r) continue;
    const ref = refByFile.get(r.file);
    if (ref && !seenFile.has(r.file)) {
      seenFile.add(r.file);
      imageRefs.push(ref);
    }
  }

  return { imageRefs, strippedText: stripSpans(text, spans), skipped };
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
 * Collect markdown image mentions `![alt](path)` and `![alt](<path>)` that are
 * LOCAL, supported image embeds. Angle-bracket destinations may contain spaces;
 * the brackets are syntax and are not part of the captured path. A leading `!`
 * is required (distinguishes an image from a doc link); a `\` before the `!`
 * escapes it (odd-run parity). A web URL target is skipped — an absolute scheme
 * (`http:`, `data:`, …) OR a protocol-relative `//host/…` — since those render
 * inline and are not workspace files. The target must have a supported image
 * extension, so the per-message cap is over eligible images (an unsupported
 * `.txt` target never consumes budget). Mentions inside a block code sample
 * (fenced or indented) are dropped — the agent is SHOWING the markdown, not
 * embedding an image. Inline code (`` `![](x)` ``) is intentionally NOT
 * excluded: a rare place for a full embed, and treating it as live keeps the
 * send side from reproducing the renderer's inline parsing.
 */
function collectImageOccurrences(text: string): ImageOccurrence[] {
  // Guard: skip capture on an absurdly large body so a pathological message can
  // never make a synchronous `chat send` appear to hang. Capture is
  // best-effort, so an over-length body just sends verbatim.
  if (text.length > MAX_IMAGE_SCAN_CHARS) return [];

  // Cheap first pass: find the candidate image embeds with the BOUNDED regex
  // (bounded quantifiers keep it linear — an unbounded `[^\]\n]*` would rescan
  // to EOF at every `![`). Only when there IS a candidate do we compute the
  // (more expensive) code ranges — an ordinary text-only send pays nothing here.
  const re = /!\[[^\]\n]{0,512}\]\((?:<([^<>\n]{1,2048})>|([^\s)"]{1,2048}))(?:\s+"[^"]*")?\)/g;
  const candidates: ImageOccurrence[] = [];
  let match: RegExpExecArray | null = re.exec(text);
  while (match !== null) {
    const whole = match[0];
    const target = match[1] ?? match[2];
    const start = match.index;
    // CommonMark escape parity: `!` is escaped only by an ODD run of
    // backslashes. `\![](x)` is an escaped literal (skip); `\\![](x)` is a
    // literal backslash + a LIVE image (do not skip).
    let backslashes = 0;
    for (let p = start - 1; p >= 0 && text[p] === "\\"; p -= 1) backslashes += 1;
    const escaped = backslashes % 2 === 1;
    const mime = target ? imageMimeForPath(target) : null;
    if (!escaped && target && mime && !isWebUrl(target)) {
      candidates.push({ writtenPath: target, mime, start, end: start + whole.length });
    }
    match = re.exec(text);
  }
  if (candidates.length === 0) return [];

  // Filter out candidates that sit inside a block code sample (fenced or
  // indented, at any container depth) — a shown sample, not an embed. Ranges
  // come from the renderer's own markdown parser (`mdast-util-from-markdown`),
  // so this matches exactly what ReactMarkdown treats as a code block, with no
  // hand-rolled CommonMark divergence. `blockCodeRanges` is sorted by start and
  // candidates are in source order, so a single monotonic cursor decides all
  // candidates in O(candidates + ranges). (Inline `` `code` `` is deliberately
  // NOT excluded — a rare place for a full embed, and treating it as live keeps
  // the send-side from having to reproduce inline CommonMark parsing.)
  const codeRanges = blockCodeRanges(text);
  const out: ImageOccurrence[] = [];
  let ri = 0;
  for (const c of candidates) {
    while (ri < codeRanges.length) {
      const r = codeRanges[ri];
      if (r && r.end <= c.start) ri += 1;
      else break;
    }
    const r = codeRanges[ri];
    const inside = r !== undefined && c.start >= r.start && c.start < r.end;
    if (!inside) out.push(c);
  }
  return out;
}

/** Backstop on the body length (UTF-16 code units) we will scan for image
 *  embeds — bounds worst-case work on a synchronous send. ~1 million chars is
 *  far above any real chat message. */
const MAX_IMAGE_SCAN_CHARS = 1024 * 1024;

/** True for a web URL target that renders inline as-is, so it is NOT a
 *  workspace file: an absolute scheme (`http:`, `data:`, …) OR a
 *  protocol-relative `//host/…`. A Windows drive prefix like `C:` is not a
 *  scheme (single letter). */
function isWebUrl(target: string): boolean {
  return target.startsWith("//") || /^[a-z][a-z0-9+.-]+:/i.test(target);
}

/**
 * `[start, end)` offset ranges of every block code sample (fenced or indented,
 * at any container depth) in `text`, from the renderer's own markdown parser so
 * capture treats a code block exactly as ReactMarkdown does — including fences
 * nested in blockquotes / list items. Inline code (`inlineCode`) is not
 * included. Sorted by start. Parser failure degrades to no ranges (best-effort).
 */
function blockCodeRanges(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let tree: unknown;
  try {
    tree = fromMarkdown(text);
  } catch {
    return out;
  }
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as {
      type?: unknown;
      position?: { start?: { offset?: unknown }; end?: { offset?: unknown } };
      children?: unknown;
    };
    if (n.type === "code") {
      const start = n.position?.start?.offset;
      const end = n.position?.end?.offset;
      if (typeof start === "number" && typeof end === "number") out.push({ start, end });
    }
    if (Array.isArray(n.children)) for (const child of n.children) walk(child);
  };
  walk(tree);
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Remove `[start,end)` spans from `text`. When a removed image sat on its own
 * blank-line-separated line, the newlines on either side would merge into an
 * extra blank line; we clamp the newline run AT EACH REMOVED-SPAN JOIN to at
 * most one blank line. The clamp only touches whitespace straddling a removed
 * span — text elsewhere (e.g. blank lines inside a preserved code block) is
 * kept byte-for-byte. A final `trim()` drops leading/trailing whitespace of the
 * resulting caption.
 */
function stripSpans(text: string, spans: Array<{ start: number; end: number }>): string {
  if (spans.length === 0) return text.trim();
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const span of ordered) {
    if (span.start < cursor) continue;
    out += text.slice(cursor, span.start);
    cursor = span.end;
    // Clamp only the newline run straddling this join. If the kept text ends
    // with a newline and the remaining text begins with a whitespace-only run
    // containing a newline, the removed image was its own line — drop that
    // leading run and normalize the trailing run to a single blank line.
    if (/\n[ \t]*$/.test(out)) {
      const leading = /^[ \t]*(?:\n[ \t]*)+/.exec(text.slice(cursor))?.[0] ?? "";
      if (leading) {
        cursor += leading.length;
        out = out.replace(/(?:[ \t]*\n)+[ \t]*$/, "\n\n");
      }
    }
  }
  out += text.slice(cursor);
  return out.trim();
}
