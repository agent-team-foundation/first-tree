import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_DATA_DIR } from "@agent-team-foundation/first-tree-hub-shared/config";

/**
 * Local cache of message attachments (route 2 / PG-bytea). Unlike the legacy
 * image store — whose bytes arrived via a best-effort `image_payload` WS push —
 * these bytes are fetched on demand from the server's member-gated download
 * route and written here so the model's Read tool can open them. Reliable +
 * re-fetchable: a cache miss just means "download again", never "lost".
 */

function sanitize(segment: string): string {
  return /^[a-zA-Z0-9._-]+$/.test(segment) ? segment : "unknown";
}

function attachmentDir(chatId: string): string {
  return join(DEFAULT_DATA_DIR, "chats", sanitize(chatId), "attachments");
}

/** Lower-cased dotted extension from a filename, or "" — kept so the on-disk
 *  file carries a real suffix (Claude's Read uses it for image vs text). */
function extFromFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return "";
  const ext = filename.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]+$/.test(ext) ? `.${ext}` : "";
}

export function attachmentPath(chatId: string, attachmentId: string, filename: string): string {
  return join(attachmentDir(chatId), `${sanitize(attachmentId)}${extFromFilename(filename)}`);
}

/** Locate a previously-downloaded attachment on disk, or null. */
export function findAttachmentPath(chatId: string, attachmentId: string, filename: string): string | null {
  const p = attachmentPath(chatId, attachmentId, filename);
  return existsSync(p) ? p : null;
}

/** Persist downloaded bytes to disk, returning the path. Idempotent. */
export async function writeAttachmentFile(
  chatId: string,
  attachmentId: string,
  filename: string,
  bytes: Buffer,
): Promise<string> {
  const dir = attachmentDir(chatId);
  await mkdir(dir, { recursive: true });
  const p = attachmentPath(chatId, attachmentId, filename);
  await writeFile(p, bytes);
  return p;
}
