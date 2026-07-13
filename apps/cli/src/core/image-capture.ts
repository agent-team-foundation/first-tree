import { buildMessageImageSnapshots, type FirstTreeHubSDK } from "@first-tree/client";
import type { ImageRefContent, MessageFormat } from "@first-tree/shared";
import { resolveChatOrgId, resolveSelfFenceFromEnv } from "./capture-context.js";

/**
 * Capture the workspace images an outbound `chat send` body references, the
 * picture sibling of `captureOutboundDocs`. An agent that writes a markdown
 * image `![alt](path)` pointing at a local image inside its own workspace gets
 * the bytes uploaded to the org attachment store; the caller then sends the
 * message as a `format: "file"` image batch (caption = the image-stripped body,
 * attachments = these refs) so web renders it exactly like a human image send.
 *
 * Like doc capture, this resolves the send-side fence from the runtime-injected
 * env and the upload org from the target chat, so it is a pure pass-through
 * (empty refs, unchanged content) outside an agent session or when the org
 * can't be resolved. Capture failure NEVER blocks the send.
 */
export async function captureOutboundImages(
  content: string,
  ctx: { sdk: FirstTreeHubSDK; chatId?: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ caption: string; imageRefs: ImageRefContent[] }> {
  const self = resolveSelfFenceFromEnv(env);
  if (!self || !ctx.chatId) return { caption: content, imageRefs: [] };

  try {
    const orgId = await resolveChatOrgId(ctx.sdk, ctx.chatId);
    if (!orgId) return { caption: content, imageRefs: [] };
    const { imageRefs, strippedText } = await buildMessageImageSnapshots(content, self, { uploader: ctx.sdk, orgId });
    return { caption: strippedText, imageRefs };
  } catch {
    return { caption: content, imageRefs: [] };
  }
}

/**
 * Decide the outbound `format` + `content` given the doc-captured body and the
 * image-capture result. When any image captured (and the base format is an
 * image-eligible text/markdown), the send becomes a human-identical
 * `imageBatchRefContent` file message: caption = the image-stripped body
 * (omitted when empty), attachments = the refs. `card`/`request`/`reference`
 * bodies and image-free sends pass through unchanged. Pure + synchronous so the
 * conversion is unit-tested without a live send.
 */
export function toOutboundImageMessage(
  baseFormat: MessageFormat,
  docContent: string,
  captured: { caption: string; imageRefs: ImageRefContent[] },
): { format: MessageFormat; content: unknown } {
  const eligible = baseFormat === "text" || baseFormat === "markdown";
  if (!eligible || captured.imageRefs.length === 0) return { format: baseFormat, content: docContent };
  return {
    format: "file",
    content: {
      ...(captured.caption.trim() ? { caption: captured.caption } : {}),
      attachments: captured.imageRefs,
    },
  };
}
