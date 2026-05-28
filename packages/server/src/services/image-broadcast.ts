import { randomUUID } from "node:crypto";
import {
  type ImageBatchRefContent,
  type ImagePayloadFrame,
  type ImageRefContent,
  imageBatchInlineContentSchema,
  imageInlineContentSchema,
  type SendMessage,
} from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { BadRequestError } from "../errors.js";
import type { Notifier } from "./notifier.js";

/**
 * A `format: "file"` content that carries an `attachments` array is a batch
 * send. We use this loose shape check (not the full schema) to tell "the
 * caller meant to send a batch" from "this is a single-image / non-image
 * file message" — so an over-limit or malformed batch is REJECTED rather
 * than silently falling through to the single-image parse (which also fails)
 * and persisting the raw inline payload verbatim into `messages.content`.
 */
function looksLikeBatchContent(content: unknown): boolean {
  return (
    typeof content === "object" && content !== null && Array.isArray((content as { attachments?: unknown }).attachments)
  );
}

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

  // Batch shape: caption + N inline images. Composers send one message per
  // user "send" action regardless of how many images were attached. Each
  // attachment still gets its own `image_payload` push (clients keep their
  // per-imageId disk-write path unchanged); the persisted content collapses
  // the inline bytes into a single batch-ref shape.
  const batchParsed = imageBatchInlineContentSchema.safeParse(data.content);
  if (batchParsed.success) {
    const inboxIds = await collectTargetInboxes(db, chatId);
    const refs: ImageRefContent[] = [];
    for (const attachment of batchParsed.data.attachments) {
      const imageId = attachment.imageId ?? randomUUID();
      const frame: ImagePayloadFrame = {
        type: "image_payload",
        imageId,
        chatId,
        base64: attachment.data,
        mimeType: attachment.mimeType,
        filename: attachment.filename,
        ...(attachment.size !== undefined ? { size: attachment.size } : {}),
      };
      const serialised = JSON.stringify(frame);
      for (const inboxId of inboxIds) {
        notifier.pushFrameToInbox(inboxId, serialised).catch(() => {
          // Best-effort side channel; missing-byte case surfaces a
          // placeholder downstream just like the single-image path.
        });
      }
      refs.push({
        imageId,
        mimeType: attachment.mimeType,
        filename: attachment.filename,
        ...(attachment.size !== undefined ? { size: attachment.size } : {}),
      });
    }
    const batchRef: ImageBatchRefContent = {
      ...(batchParsed.data.caption !== undefined ? { caption: batchParsed.data.caption } : {}),
      attachments: refs,
    };
    return {
      ...data,
      content: batchRef,
    };
  }

  // The content looked like a batch (has an `attachments` array) but failed
  // the batch schema above — too many attachments (> MAX_BATCH_ATTACHMENTS)
  // or a malformed entry. Reject it: without this guard the parse falls
  // through to the single-image branch (which also fails) and `return data`
  // would persist the raw inline base64 (up to the route bodyLimit) verbatim
  // into the immutable `messages.content`, push no `image_payload` frames,
  // and render as a broken JSON blob on every client. The `.max()` schema cap
  // is only a real defence if exceeding it is a 400, not a silent passthrough.
  if (looksLikeBatchContent(data.content)) {
    throw new BadRequestError(`Invalid image batch: ${batchParsed.error.issues[0]?.message ?? "failed validation"}`);
  }

  // Legacy single-image path: kept for clients that still send the
  // pre-batch shape. Behaviour is unchanged — extract bytes, push one frame,
  // rewrite content to a single ref.
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
