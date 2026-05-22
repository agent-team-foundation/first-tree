import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { IMAGE_MIME_TO_EXT, type SupportedImageMime } from "@first-tree/shared";
import { DEFAULT_DATA_DIR } from "@first-tree/shared/config";

/** UUIDs are the only shape we generate for imageId, but accept the same
 * loose character set as chatId sanitisers elsewhere so a malformed field
 * can never break out of the images dir. */
function sanitize(segment: string): string {
  return /^[a-zA-Z0-9-]+$/.test(segment) ? segment : "unknown";
}

function imageDir(chatId: string): string {
  return join(DEFAULT_DATA_DIR, "chats", sanitize(chatId), "images");
}

export function imagePath(chatId: string, imageId: string, mimeType: SupportedImageMime): string {
  const ext = IMAGE_MIME_TO_EXT[mimeType];
  return join(imageDir(chatId), `${sanitize(imageId)}.${ext}`);
}

/**
 * Locate a previously-written image file on disk. Returns null when the
 * file is missing — caller should surface the "image not available on
 * this device" placeholder in that case.
 */
export function findImagePath(chatId: string, imageId: string, mimeType: SupportedImageMime): string | null {
  const p = imagePath(chatId, imageId, mimeType);
  return existsSync(p) ? p : null;
}

/**
 * Persist image bytes to `<dataDir>/chats/<chatId>/images/<imageId>.<ext>`.
 * Idempotent — rewriting the same imageId is a no-op overwrite.
 */
export async function writeImage(params: {
  chatId: string;
  imageId: string;
  mimeType: SupportedImageMime;
  base64: string;
}): Promise<string> {
  const dir = imageDir(params.chatId);
  await mkdir(dir, { recursive: true });
  const path = imagePath(params.chatId, params.imageId, params.mimeType);
  await writeFile(path, Buffer.from(params.base64, "base64"));
  return path;
}
