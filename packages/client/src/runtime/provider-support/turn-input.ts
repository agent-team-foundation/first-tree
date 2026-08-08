/**
 * Provider-support turn-input group.
 *
 * Runtime-owned inbound turn plumbing shared by adapters: streaming input
 * controller, document/image attachment rendering for LLM prompts, and image
 * path lookup. Does not own provider-native protocol translation.
 */

export { renderDocumentAttachmentsForLLM, renderImageAttachmentsForLLM } from "../agent-io.js";
export { findImagePath, imagePath, writeImage } from "../image-store.js";
export { InputController } from "../input-controller.js";
