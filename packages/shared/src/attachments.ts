import { deriveAttachmentKind } from "./schemas/message.js";

/**
 * Attachment validation + limits, shared by the server (authoritative gate at
 * the upload endpoint) and the web composer (pre-flight UX). Dependency-free on
 * purpose — the magic-byte sniff is a small inline signature table, not a
 * library, so `@agent-team-foundation/first-tree-hub-shared` stays runtime-free.
 *
 * Design: proposals/hub-message-text-attachments.20260521.md (route 2 + PG-bytea).
 * Only mime/type validation lives in shared (O3) — storage / signing / GC stay
 * server-side until a second caller exists.
 */

const MB = 1024 * 1024;

/** Hard size / count gates (decision 4). */
export const ATTACHMENT_LIMITS = {
  /** Per single attachment. */
  maxFileBytes: 10 * MB,
  /** Sum of all attachments on one message. */
  maxMessageBytes: 25 * MB,
  /** Attachments per message. */
  maxMessageCount: 9,
  /** Per-org total stored bytes (PG bytea footprint guard). */
  orgQuotaBytes: 10 * 1024 * MB,
} as const;

/**
 * HTTP `bodyLimit` for the (single-file) multipart upload endpoint. Sized to
 * one max file plus multipart envelope overhead — NOT the per-message total.
 * Explicit because the messages routes otherwise inherit Fastify's 1 MB
 * default (see app.ts), which would silently cap uploads.
 */
export const ATTACHMENT_UPLOAD_BODY_LIMIT = ATTACHMENT_LIMITS.maxFileBytes + 4 * MB;

/**
 * Extensions never accepted — executables, scripts, installers, libraries,
 * shortcuts. Scripts have no reliable magic bytes, so the extension gate is the
 * primary defence for those (the byte sniff catches disguised binaries).
 */
export const DENIED_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".exe",
  ".bat",
  ".cmd",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".scr",
  ".jar",
  ".app",
  ".dmg",
  ".msi",
  ".vbs",
  ".com",
  ".pif",
  ".dll",
  ".so",
  ".lnk",
  ".bin",
  ".cgi",
  ".jse",
  ".wsf",
]);

/**
 * Safe text/document types that legitimately have NO magic bytes (C1). For
 * these, "no magic detected" must be ALLOWED — rejecting on "couldn't sniff"
 * would block the documents this feature exists to carry. `.svg` is included
 * but is download-only (see {@link INLINE_SAFE_IMAGE_MIMES}).
 */
export const MAGICLESS_SAFE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".text",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".log",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".htm",
  ".rtf",
  ".svg",
]);

/**
 * The only mime types served inline (`<img>`). Everything else — including
 * `image/svg+xml`, which can carry script — is served with
 * `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff` so a
 * malicious payload can never execute in the Hub origin (C2).
 */
export const INLINE_SAFE_IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export function fileExtension(filename: string): string {
  const slash = Math.max(filename.lastIndexOf("/"), filename.lastIndexOf("\\"));
  const base = slash >= 0 ? filename.slice(slash + 1) : filename;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

function startsWith(head: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (head.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (head[offset + i] !== sig[i]) return false;
  }
  return true;
}

/**
 * Detect executable / native-binary content regardless of declared mime or
 * extension. These are rejected unconditionally (the "rename evil.exe to
 * cat.png" case).
 */
export function looksExecutable(head: Uint8Array): boolean {
  // Windows PE ("MZ"), ELF (0x7F 'E' 'L' 'F'), shebang ("#!")
  if (startsWith(head, [0x4d, 0x5a])) return true;
  if (startsWith(head, [0x7f, 0x45, 0x4c, 0x46])) return true;
  if (startsWith(head, [0x23, 0x21])) return true;
  // Mach-O (32/64, LE/BE) + universal binary
  for (const sig of [
    [0xfe, 0xed, 0xfa, 0xce],
    [0xfe, 0xed, 0xfa, 0xcf],
    [0xce, 0xfa, 0xed, 0xfe],
    [0xcf, 0xfa, 0xed, 0xfe],
    [0xca, 0xfe, 0xba, 0xbe],
  ]) {
    if (startsWith(head, sig)) return true;
  }
  return false;
}

/**
 * Best-effort magic-byte sniff for the formats we expect. Returns the detected
 * mime, or `null` when nothing matched (which is fine for magicless safe text —
 * see {@link classifyAttachment}).
 */
export function sniffMime(head: Uint8Array): string | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  // WEBP: "RIFF" .... "WEBP"
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46])) return "application/pdf"; // %PDF
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return "application/zip"; // also docx/xlsx/pptx
  if (startsWith(head, [0x1f, 0x8b])) return "application/gzip";
  return null;
}

export class AttachmentRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentRejectedError";
  }
}

export type AttachmentClassification = {
  /** image → may be inline (if also INLINE_SAFE); file → card + download. */
  kind: "image" | "file";
  /** mime to persist: sniffed when known, else the declared mime. */
  mimeType: string;
};

/**
 * Authoritative type gate (server) + reusable pre-flight (web). Throws
 * {@link AttachmentRejectedError} on any disallowed input.
 *
 *   1. size cap;
 *   2. extension deny list (scripts/executables/installers);
 *   3. executable byte signature → reject regardless of name (disguised binary);
 *   4. magic sniff: if detected, trust it; if NOT detected, allow only when the
 *      extension is a known magicless-safe text/doc type (C1) — otherwise reject
 *      "couldn't verify".
 */
export function classifyAttachment(args: {
  filename: string;
  declaredMime: string;
  head: Uint8Array;
  size: number;
}): AttachmentClassification {
  if (args.size <= 0) throw new AttachmentRejectedError("Empty attachment.");
  if (args.size > ATTACHMENT_LIMITS.maxFileBytes) {
    throw new AttachmentRejectedError(
      `Attachment too large (${(args.size / MB).toFixed(1)}MB; max ${ATTACHMENT_LIMITS.maxFileBytes / MB}MB).`,
    );
  }

  const ext = fileExtension(args.filename);
  if (DENIED_ATTACHMENT_EXTENSIONS.has(ext)) {
    throw new AttachmentRejectedError(`File type "${ext}" is not allowed.`);
  }
  if (looksExecutable(args.head)) {
    throw new AttachmentRejectedError("Executable content is not allowed.");
  }

  const sniffed = sniffMime(args.head);
  if (!sniffed && !MAGICLESS_SAFE_EXTENSIONS.has(ext)) {
    throw new AttachmentRejectedError("Could not verify file type — upload a supported document or image.");
  }

  const mimeType = sniffed ?? args.declaredMime;
  return { kind: deriveAttachmentKind(mimeType), mimeType };
}

/** Whether the download route may serve this mime inline (`<img>`) vs forced download (C2). */
export function isInlineSafeImage(mimeType: string): boolean {
  return INLINE_SAFE_IMAGE_MIMES.has(mimeType);
}
