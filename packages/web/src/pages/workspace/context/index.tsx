import { AgentContext } from "./agent-context.js";
import { SessionContext } from "./session-context.js";

export function ContextPanel({
  selectedAgentId,
  selectedChatId,
}: {
  selectedAgentId: string | null;
  selectedChatId: string | null;
}) {
  if (selectedChatId && selectedAgentId) {
    return <SessionContext agentId={selectedAgentId} chatId={selectedChatId} />;
  }
  if (selectedAgentId) {
    return <AgentContext agentId={selectedAgentId} />;
  }
  return null;
}
