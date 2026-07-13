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
  onClearChat,
  narrow,
  onShowConversations,
  initialParticipantIds,
  presentation = "workspace",
  isTrial = false,
}: {
  selectedChatId: string | null;
  onSelectChat: (chatId: string) => void;
  onClearChat: () => void;
  /** Landing-campaign trial surface: hide chat-management escape hatches
   *  (new chat, add participant, agent pause/resume) — the trial chat is a
   *  controlled, single-run surface. */
  isTrial?: boolean;
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
  presentation?: "workspace" | "mobile";
}) {
  const { organizationId } = useAuth();

  if (selectedChatId === DRAFT_CHAT_ID) {
    // The key resets all of NewChatDraft's local state on remount — chips,
    // draft text, pending images, and the `knownAgents` accumulator.
    //   - organizationId: switching orgs must drop a stale uuid that could
    //     resolve a new-org `@bob` to a stranger (server then 4xxs).
    //   - initialParticipantIds (`?with=`): the seed effect is one-shot
    //     (seededDefaultRef), so re-navigating from Team's "Chat" on agent A
    //     then agent B (`?c=draft&with=A` → `…with=B`) would otherwise leave
    //     chips on [A] and send to the wrong target. Folding `with` into the
    //     key forces a fresh draft seeded with the new participants (and
    //     clears any half-typed body that belonged to the previous target).
    return (
      <NewChatDraft
        key={`${organizationId ?? "no-org"}:${(initialParticipantIds ?? []).join(",")}`}
        onCreated={onSelectChat}
        onShowConversations={onShowConversations}
        initialParticipantIds={initialParticipantIds}
        mobile={presentation === "mobile"}
      />
    );
  }

  if (selectedChatId) {
    return (
      <ChatByIdView
        chatId={selectedChatId}
        narrow={narrow}
        onShowConversations={onShowConversations}
        onClearChat={onClearChat}
        isTrial={isTrial}
        presentation={presentation}
      />
    );
  }

  return <NoChatView onNewChat={() => onSelectChat(DRAFT_CHAT_ID)} isTrial={isTrial} />;
}
