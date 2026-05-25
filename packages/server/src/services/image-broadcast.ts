import { randomUUID } from "node:crypto";
import {
  type ImagePayloadFrame,
  type ImageRefContent,
  imageInlineContentSchema,
  type SendMessage,
} from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import type { Notifier } from "./notifier.js";

/**
 * Intercepts outbound image messages. If `data.content` carries an inline
 * base64 image (legacy-style payload from the web), we:
 *
 *   1. Generate / adopt an `imageId`
 *   2. Push the bytes as an `image_payload` WS frame to every participant
 *      agent's inbox. Cross-chat reply routing has been removed (see
 *      first-tree-context PR #281), so there is no extra reply-to fan-out
 *      to match — the chat's own participant list is the full audience.
 *      Best-effort, local instance only, no PG NOTIFY.
 *   3. Return a copy of `data` whose `content` is just the reference
 *      {imageId, mimeType, filename, size}
 *
 * The push is fire-and-forget: `ws.send()` queues the frame into the socket's
 * send buffer synchronously, which is the only ordering guarantee we need —
 * the subsequent `inbox:deliver` frame is driven by a PG NOTIFY round trip,
 * so the image lands first on the wire. Awaiting the TCP flush here would
 * put a slow subscriber's backpressure on the sender's HTTP response for a
 * feature that is already best-effort.
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

  const inboxIds = await collectTargetInboxes(db, chatId);
  for (const inboxId of inboxIds) {
    notifier.pushFrameToInbox(inboxId, serialised).catch(() => {
      // Best-effort side channel; downstream already surfaces a placeholder
      // when the bytes never arrived on a given client.
    });
  }

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

/**
 * Mirror `sendMessage`'s fan-out set: every speaker in the chat receives
 * the image-bytes broadcast. Cross-chat reply routing and the
 * `replyToInbox` envelope were removed alongside the sub-chat cleanup
 * (first-tree-context PR #281), so the chat's own speaker list is the
 * full audience.
 */
async function collectTargetInboxes(db: Database, chatId: string): Promise<string[]> {
  const participants = await db
    .select({ inboxId: agents.inboxId })
    .from(chatMembership)
    .innerJoin(agents, eq(chatMembership.agentId, agents.uuid))
    .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker")));

  return [...new Set(participants.map((p) => p.inboxId))];
}
