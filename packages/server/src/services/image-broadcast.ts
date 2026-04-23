import { randomUUID } from "node:crypto";
import {
  type ImagePayloadFrame,
  type ImageRefContent,
  imageInlineContentSchema,
  type SendMessage,
} from "@agent-team-foundation/first-tree-hub-shared";
import { eq } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatParticipants } from "../db/schema/chats.js";
import type { Notifier } from "./notifier.js";

/**
 * Intercepts outbound image messages. If `data.content` carries an inline
 * base64 image (legacy-style payload from the web), we:
 *
 *   1. Generate / adopt an `imageId`
 *   2. Push the bytes as an `image_payload` WS frame to every participant
 *      agent's inbox — best-effort, local instance only, no PG NOTIFY
 *   3. Return a copy of `data` whose `content` is just the reference
 *      {imageId, mimeType, filename, size}
 *
 * Non-image messages are returned unchanged. Missing-subscriber / wrong-
 * instance cases are acceptable loss per the image-out-of-messages design
 * (the reference-only message still lands in the DB; clients that missed
 * the bytes surface a "not available on this device" placeholder).
 */
export async function prepareImageOutbound(
  db: Database,
  notifier: Notifier,
  chatId: string,
  data: SendMessage,
): Promise<SendMessage> {
  if (data.format !== "file") return data;
  const parsed = imageInlineContentSchema.safeParse(data.content);
  if (!parsed.success) return data;

  const inline = parsed.data;
  const imageId = inline.imageId ?? randomUUID();

  const frame: ImagePayloadFrame = {
    type: "image_payload",
    imageId,
    chatId,
    base64: inline.data,
    mimeType: inline.mimeType,
    filename: inline.filename,
    ...(inline.size !== undefined ? { size: inline.size } : {}),
  };
  const serialised = JSON.stringify(frame);

  const rows = await db
    .select({ inboxId: agents.inboxId })
    .from(chatParticipants)
    .innerJoin(agents, eq(chatParticipants.agentId, agents.uuid))
    .where(eq(chatParticipants.chatId, chatId));

  await Promise.all(rows.map((row) => notifier.pushFrameToInbox(row.inboxId, serialised)));

  const ref: ImageRefContent = {
    imageId,
    mimeType: inline.mimeType,
    filename: inline.filename,
    ...(inline.size !== undefined ? { size: inline.size } : {}),
  };

  return {
    ...data,
    content: ref,
  };
}
