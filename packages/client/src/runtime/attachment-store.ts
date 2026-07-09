import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultDataDir } from "@first-tree/shared/config";

/**
 * On-disk store for document/file attachments an agent receives — the
 * counterpart to `image-store.ts`. Unlike images (which the runtime hands the
 * model as a path to Read), a document is written under its original filename
 * so the agent sees the real name + extension and can pick the right tool
 * (Read for text/pdf, a shell parser for xlsx/docx). Bytes land at
 * `<dataDir>/chats/<chatId>/files/<attachmentId>-<filename>`.
 */

/** UUID-shaped ids only; fall back to a fixed segment so a malformed field can
 * never break out of the files dir. Mirrors `image-store.ts::sanitize`. */
function sanitizeSegment(segment: string): string {
  return /^[a-zA-Z0-9-]+$/.test(segment) ? segment : "unknown";
}

/**
 * Reduce a user-supplied filename to a safe basename: drop any path, keep only
 * portable name characters, strip leading dots, and bound the length. The
 * attachmentId prefix (added by the caller) guarantees uniqueness, so a
 * collision-forced rename here is harmless.
 */
const MAX_SAFE_FILENAME_LENGTH = 200;
const MAX_EXTENSION_LENGTH = 24;

function sanitizeFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? filename;
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "");
  if (cleaned.length === 0) return "file";
  if (cleaned.length <= MAX_SAFE_FILENAME_LENGTH) return cleaned;

  const dot = cleaned.lastIndexOf(".");
  const extension =
    dot > 0 && dot < cleaned.length - 1 && cleaned.length - dot <= MAX_EXTENSION_LENGTH ? cleaned.slice(dot) : "";
  if (extension.length === 0) return cleaned.slice(0, MAX_SAFE_FILENAME_LENGTH);

  return `${cleaned.slice(0, MAX_SAFE_FILENAME_LENGTH - extension.length)}${extension}`;
}

function attachmentDir(chatId: string): string {
  return join(defaultDataDir(), "chats", sanitizeSegment(chatId), "files");
}

export function attachmentFilePath(chatId: string, attachmentId: string, filename: string): string {
  return join(attachmentDir(chatId), `${sanitizeSegment(attachmentId)}-${sanitizeFilename(filename)}`);
}

/** Locate a previously-written attachment file; null when it is not on disk. */
export function findAttachmentFile(chatId: string, attachmentId: string, filename: string): string | null {
  const p = attachmentFilePath(chatId, attachmentId, filename);
  return existsSync(p) ? p : null;
}

/**
 * Persist attachment bytes to
 * `<dataDir>/chats/<chatId>/files/<attachmentId>-<filename>`. Idempotent —
 * rewriting the same attachment is a no-op overwrite.
 */
export async function writeAttachmentFile(params: {
  chatId: string;
  attachmentId: string;
  filename: string;
  base64: string;
}): Promise<string> {
  const dir = attachmentDir(params.chatId);
  await mkdir(dir, { recursive: true });
  const path = attachmentFilePath(params.chatId, params.attachmentId, params.filename);
  await writeFile(path, Buffer.from(params.base64, "base64"));
  return path;
}
