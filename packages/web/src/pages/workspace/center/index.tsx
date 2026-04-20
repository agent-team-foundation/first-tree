import { ChatView } from "./chat-view.js";
import { EmptyState } from "./empty-state.js";

export function CenterPanel({
  selectedAgentId,
  selectedChatId,
}: {
  selectedAgentId: string | null;
  selectedChatId: string | null;
}) {
  if (selectedChatId && selectedAgentId) {
    return <ChatView agentId={selectedAgentId} chatId={selectedChatId} />;
  }
  return <EmptyState />;
}
