import { useAuth } from "../../../auth/auth-context.js";
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
  const { organizationId } = useAuth();

  if (selectedChatId === DRAFT_CHAT_ID) {
    // `key={organizationId}` resets all of NewChatDraft's local state when
    // the user switches orgs while a draft is open — chips, draft text,
    // pending images, and crucially the `knownAgents` accumulator (which
    // resolves @-name → uuid for `extractMentions`). Without this remount,
    // a uuid from the previous org could stay in the cache and silently
    // resolve a new-org `@bob` to a stranger; the server then 4xxs the
    // chat create with a confusing visibility error.
    return <NewChatDraft key={organizationId ?? "no-org"} onCreated={onSelectChat} />;
  }

  if (selectedChatId) {
    return <ChatByIdView chatId={selectedChatId} />;
  }

  return <NoChatView onNewChat={() => onSelectChat(DRAFT_CHAT_ID)} />;
}
