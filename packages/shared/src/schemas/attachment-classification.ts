import type { AttachmentKind } from "./attachment-ref.js";
import { SUPPORTED_IMAGE_MIMES } from "./image-payload.js";

/**
 * Composer upload allowlist + kind classification.
 *
 * A single source of truth for "which files may be attached in the chat
 * composer, and what {@link AttachmentKind} each maps to". Both the composer
 * (file-picker `accept` + drop/paste filtering) and any server-side soft check
 * derive from here.
 *
 * The primitive at `POST /orgs/:orgId/attachments` is intentionally
 * MIME-agnostic (see `system/cloud/chat/attachments.md`); this allowlist is a
 * *product/UX* gate, not a security boundary. It exists because uploads are
 * primarily for an agent to read: we admit formats an agent can actually
 * consume (text-native directly; office via extraction) and keep out blobs it
 * cannot use (archives, executables, audio/video).
 *
 * Classification is keyed by lowercase file extension first, then MIME. Browser
 * `File.type` is empty or `text/plain` for several useful formats (`.md`,
 * `.csv`, source files), so the extension is the more reliable signal.
 */

/**
 * Text-native formats: the bytes ARE the content, so an agent reads them from
 * disk with zero extraction. Extension-keyed (their MIME is unreliable).
 */
export const TEXT_NATIVE_EXTENSIONS = [
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".htm",
  ".log",
  ".toml",
  ".ini",
  // common source files — an agent reads these directly too
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".h",
  ".cpp",
  ".rb",
  ".php",
  ".sh",
  ".sql",
  ".css",
] as const;

/**
 * Office / binary documents: readable only after extraction (agent-side shell
 * or at ingestion). MIME-keyed with the canonical extension as the value.
 */
export const OFFICE_MIME_TO_EXTENSION: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
};

export const OFFICE_EXTENSIONS = [".pdf", ".docx", ".xlsx", ".pptx"] as const;

const TEXT_NATIVE_SET = new Set<string>(TEXT_NATIVE_EXTENSIONS);
const OFFICE_EXTENSION_SET = new Set<string>(OFFICE_EXTENSIONS);
const OFFICE_MIME_SET = new Set<string>(Object.keys(OFFICE_MIME_TO_EXTENSION));
const IMAGE_MIME_SET = new Set<string>(SUPPORTED_IMAGE_MIMES);

/**
 * `accept` attribute value for the composer's hidden file input: every image
 * MIME the runtime already supports, plus each allowlisted document/text/office
 * extension. Extensions cover the text-native formats whose MIME the OS dialog
 * would otherwise leave unfiltered.
 */
export const COMPOSER_ACCEPT_ATTRIBUTE = [
  ...SUPPORTED_IMAGE_MIMES,
  ...TEXT_NATIVE_EXTENSIONS,
  ...OFFICE_EXTENSIONS,
].join(",");

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot).toLowerCase() : "";
}

export type UploadClassification = {
  /** Whether this file is admitted by the composer allowlist. */
  allowed: boolean;
  /**
   * The {@link AttachmentKind} to tag the ref with. `image` renders inline;
   * `document` keeps the markdown doc-preview drawer (`.md` only today);
   * `file` renders as a download chip and is the shape for every other
   * admitted upload. Meaningful only when `allowed` is true.
   */
  kind: AttachmentKind;
};

/**
 * Classify a file selected in the composer into an allow/deny decision plus the
 * {@link AttachmentKind} to store. Extension wins over MIME because the browser
 * omits or mislabels the MIME for text-native formats.
 */
export function classifyComposerUpload(mimeType: string, filename: string): UploadClassification {
  const ext = extensionOf(filename);
  const mime = mimeType.toLowerCase();

  if (IMAGE_MIME_SET.has(mime)) {
    return { allowed: true, kind: "image" };
  }
  // `.md` keeps the `document` kind so it still opens in the doc-preview drawer;
  // every other admitted upload is a download-chip `file`.
  if (ext === ".md" || ext === ".markdown") {
    return { allowed: true, kind: "document" };
  }
  if (TEXT_NATIVE_SET.has(ext) || OFFICE_EXTENSION_SET.has(ext) || OFFICE_MIME_SET.has(mime)) {
    return { allowed: true, kind: "file" };
  }
  return { allowed: false, kind: "file" };
}
