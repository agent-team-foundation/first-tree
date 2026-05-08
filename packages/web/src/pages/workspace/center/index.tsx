import { useAuth } from "../../../auth/auth-context.js";
import { DRAFT_CHAT_ID } from "../conversations/index.js";
import { NewChatDraft } from "../conversations/new-chat-draft.js";
import { ChatByIdView } from "./chat-by-id.js";
import { NoChatView } from "./no-chat-view.js";
import { OnboardingView } from "./onboarding-view.js";

/**
 * Center-panel router for the chat-first workspace.
 *
 *   1. NewChatDraft     — `?c=draft` (or no chat selected and the user
 *                          asked for a new chat). Inline composer +
 *                          target picker.
 *   2. ChatByIdView     — `?c=<chatId>` set; chat-id-only shim around the
 *                          existing ChatView.
 *   3. OnboardingView   — onboardingStep is "connect" or "create_agent". Inline
 *                          onboarding card.
 *   4. NoChatView       — onboarding complete, nothing selected.
 */
export function CenterPanel({
  selectedChatId,
  onSelectChat,
}: {
  selectedChatId: string | null;
  onSelectChat: (chatId: string) => void;
}) {
  const { onboardingStep } = useAuth();

  if (selectedChatId === DRAFT_CHAT_ID) {
    return <NewChatDraft onCreated={onSelectChat} />;
  }

  if (selectedChatId) {
    return <ChatByIdView chatId={selectedChatId} />;
  }

  if (onboardingStep !== null && onboardingStep !== "completed") {
    return <OnboardingView />;
  }

  return <NoChatView />;
}
