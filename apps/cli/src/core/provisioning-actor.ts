import { readFileSync } from "node:fs";
import { AGENT_ACTOR_HEADER, AGENT_RUNTIME_SESSION_HEADER } from "@first-tree/shared";

/** Attach a runtime-bound actor proof when the command runs inside an agent session. */
export function provisioningActorHeaders(): Record<string, string> {
  const agentId = process.env.FIRST_TREE_AGENT_ID?.trim();
  const headers: Record<string, string> = agentId ? { [AGENT_ACTOR_HEADER]: agentId } : {};
  const tokenFile = process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE?.trim();
  if (tokenFile) {
    try {
      const token = readFileSync(tokenFile, "utf8").trim();
      if (token) headers[AGENT_RUNTIME_SESSION_HEADER] = token;
    } catch {
      // The server returns a clear active-runtime-session error.
    }
  }
  const chatId = process.env.FIRST_TREE_CHAT_ID?.trim();
  if (chatId) headers["x-first-tree-chat-id"] = chatId;
  const sessionId = process.env.FIRST_TREE_SESSION_ID?.trim();
  if (sessionId) headers["x-first-tree-session-id"] = sessionId;
  return headers;
}
