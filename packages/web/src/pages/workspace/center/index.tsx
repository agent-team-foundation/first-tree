import { DRAFT_CHAT_ID } from "../conversations/index.js";
import { NewChatDraft } from "../conversations/new-chat-draft.js";
import { ChatByIdView } from "./chat-by-id.js";
import { NoChatView } from "./no-chat-view.js";

/**
 * Center-panel router for the chat-first workspace.
 *
 *   1. NewChatDraft  — `?c=draft` (or no chat selected and the user asked for
 *                      a new chat). Inline composer + target picker.
 *   2. ChatByIdView  — `?c=<chatId>` set; chat-id-only shim around ChatView.
 *   3. NoChatView    — nothing selected; empty-state with a "New chat" CTA.
 *
 * Onboarding no longer renders here — users who haven't finished setup are
 * redirected to the standalone `/onboarding` flow (see `shouldEnterOnboarding`
 * in `pages/onboarding/steps.ts`).
 */
export function CenterPanel({
  selectedChatId,
  onSelectChat,
}: {
  selectedChatId: string | null;
  onSelectChat: (chatId: string) => void;
}) {
  if (selectedChatId === DRAFT_CHAT_ID) {
    return <NewChatDraft onCreated={onSelectChat} />;
  }

  if (selectedChatId) {
    return <ChatByIdView chatId={selectedChatId} />;
  }

  return <NoChatView onNewChat={() => onSelectChat(DRAFT_CHAT_ID)} />;
}
