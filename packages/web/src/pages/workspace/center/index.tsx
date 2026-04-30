import { useAuth } from "../../../auth/auth-context.js";
import { ChatView } from "./chat-view.js";
import { NoChatView } from "./no-chat-view.js";
import { OnboardingView } from "./onboarding-view.js";

/**
 * Center-panel router — picks one of three sibling views per the spec:
 *
 *   1. ChatView         — `?a=` AND `?c=` both set; user is actively chatting.
 *                         Wins regardless of onboarding state so a regressed
 *                         wizardStep (E4) doesn't snatch the chat away from a
 *                         user who explicitly selected one.
 *   2. OnboardingView   — wizardStep is "connect" or "create_agent". Inline
 *                         onboarding card; replaces the prior banner+modal pair.
 *   3. NoChatView       — onboarding complete, nothing selected.
 */
export function CenterPanel({
  selectedAgentId,
  selectedChatId,
}: {
  selectedAgentId: string | null;
  selectedChatId: string | null;
}) {
  const { wizardStep } = useAuth();

  if (selectedChatId && selectedAgentId) {
    return <ChatView agentId={selectedAgentId} chatId={selectedChatId} />;
  }

  if (wizardStep !== null && wizardStep !== "completed") {
    return <OnboardingView />;
  }

  return <NoChatView />;
}
