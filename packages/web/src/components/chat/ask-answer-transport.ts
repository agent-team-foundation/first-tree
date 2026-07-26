import type { AttachmentRef, RequestResolution } from "@first-tree/shared";
import { uploadAttachment, uploadMimeFor } from "../../api/attachments.js";
import { type ImageRefContent, readFileAsBase64, sendChatMessage, sendFileMessageBatch } from "../../api/chats.js";
import { putImage } from "../../api/image-store.js";
import type { AskAnswer } from "./ask-takeover.js";

export type AskAnswerRequestRef = {
  id: string;
  senderId: string;
};

/**
 * The single request-resolution transport used by every AskTakeover host.
 *
 * Surface components own pending/error state and their post-send effects. This
 * unit owns the invariants that unblock the requester: route to the asker plus
 * explicit mentions, upload staged files, choose text vs image-batch transport,
 * and attach the same in-reply-to + resolving metadata in either path.
 */
export async function sendAskAnswer({
  chatId,
  request,
  answer,
}: {
  chatId: string;
  request: AskAnswerRequestRef;
  answer: AskAnswer;
}): Promise<void> {
  const routedMentions = [...new Set([request.senderId, ...answer.mentions])];
  const resolves: RequestResolution = { request: request.id, kind: "answered" };
  const documentRefs: AttachmentRef[] = [];

  for (const attachment of answer.attachments ?? []) {
    const uploaded = await uploadAttachment(attachment.file);
    documentRefs.push({
      attachmentId: uploaded.id,
      kind: attachment.kind,
      mimeType: uploadMimeFor(attachment.file),
      filename: attachment.file.name,
      size: attachment.file.size,
    });
  }

  if (answer.images.length > 0) {
    const imageRefs: ImageRefContent[] = [];
    for (const file of answer.images) {
      const uploaded = await uploadAttachment(file);
      try {
        await putImage({ imageId: uploaded.id, base64: await readFileAsBase64(file), mimeType: file.type });
      } catch {
        // The server attachment is authoritative; IndexedDB only makes the
        // sender's thumbnail immediate and must never block resolution.
      }
      imageRefs.push({ imageId: uploaded.id, mimeType: file.type, filename: file.name, size: file.size });
    }
    await sendFileMessageBatch(
      chatId,
      { ...(answer.content ? { caption: answer.content } : {}), attachments: imageRefs },
      { mentions: routedMentions, ...(documentRefs.length > 0 ? { attachments: documentRefs } : {}) },
      { inReplyTo: request.id, resolves },
    );
    return;
  }

  await sendChatMessage(chatId, answer.content, routedMentions, {
    inReplyTo: request.id,
    resolves,
    ...(documentRefs.length > 0 ? { attachments: documentRefs } : {}),
  });
}
