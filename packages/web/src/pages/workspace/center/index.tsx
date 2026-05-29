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
  narrow,
  onShowConversations,
  initialParticipantIds,
}: {
  selectedChatId: string | null;
  onSelectChat: (chatId: string) => void;
  /** True when the workspace shell is in narrow-viewport mode (<768).
   *  Propagated to `ChatView` so it can swap the right rail to an
   *  overlay and surface the conv-list summon button. */
  narrow: boolean;
  /** Non-null only in narrow mode — invoking this opens the
   *  conversation-list overlay. ChatView renders a hamburger button
   *  in its header when provided. */
  onShowConversations: (() => void) | null;
  /** Seed chips for a fresh draft, from the `?with=` param (e.g. the Team
   *  page "Chat" action pre-selects that agent). Takes precedence over the
   *  default-delegate seed. */
  initialParticipantIds?: string[];
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
    return (
      <NewChatDraft
        key={organizationId ?? "no-org"}
        onCreated={onSelectChat}
        onShowConversations={onShowConversations}
        initialParticipantIds={initialParticipantIds}
      />
    );
  }

  if (selectedChatId) {
    return <ChatByIdView chatId={selectedChatId} narrow={narrow} onShowConversations={onShowConversations} />;
  }

  return <NoChatView onNewChat={() => onSelectChat(DRAFT_CHAT_ID)} />;
}
