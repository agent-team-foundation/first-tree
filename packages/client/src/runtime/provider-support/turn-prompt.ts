/**
 * Provider-support turn-prompt group.
 *
 * Runtime owns Current Chat Context prompt rendering, the shared output
 * contract, and briefing-fingerprint / re-read notice helpers that adapters
 * consume when translating a turn. Does not own provider-native prompt assembly.
 */

export {
  renderChatContextPrompt,
  renderChatContextSection,
  renderRuntimeOutputContract,
} from "../chat-context-section.js";

export {
  buildBriefingUpdateNotice,
  computeBriefingFingerprint,
  readSessionBriefingFingerprint,
  writeSessionBriefingFingerprint,
} from "../session-briefing-fingerprint.js";
