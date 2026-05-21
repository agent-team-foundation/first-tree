import { buildMessageDocumentSnapshots, type WorkspaceFence } from "@first-tree/client";
import { documentContextSchema } from "@first-tree/shared";

/**
 * Snapshot the `.md` documents an outbound `chat send` message references, the
 * same way the runtime's `result-sink` does for an agent's final-text reply
 * (L3: unify doc-preview capture across ALL send paths, not just final-text).
 *
 * The runtime injects the resolved doc context into the agent's environment
 * (`buildAgentEnv` → `FIRST_TREE_HUB_DOC_BASE` / `_WORKSPACES_ROOT` /
 * `_AGENT_SLUG`); we read it here so the CLI sub-process resolves against the
 * exact same base + cross-agent fence as the runtime — no config reconstruction,
 * no server round-trip.
 *
 * Returns the (possibly rewritten) content + a validated `documentContext` to
 * merge into message metadata. When no doc base is present (not in an agent
 * session, or the runtime predates this wiring) it is a pure pass-through, so
 * `chat send` keeps working unchanged.
 *
 * Capture failure NEVER blocks the send: any error degrades to passing the
 * original content through with no `documentContext`.
 */
export async function captureOutboundDocs(
  content: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ content: string; documentContext?: unknown }> {
  const base = env.FIRST_TREE_HUB_DOC_BASE;
  if (!base) return { content };

  const chatId = env.FIRST_TREE_HUB_CHAT_ID;
  const workspacesRoot = env.FIRST_TREE_HUB_WORKSPACES_ROOT;
  const selfSlug = env.FIRST_TREE_HUB_AGENT_SLUG;
  const fence: WorkspaceFence | undefined =
    workspacesRoot && selfSlug && chatId ? { workspacesRoot, chatId, selfSlug } : undefined;

  try {
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots(content, base, fence);
    if (docs.length === 0) return { content: rewrittenText };
    // Validate through the shared schema (same as result-sink) so a malformed
    // doc can never be lodged into immutable message history; on a parse error
    // fall back to sending the content with no documentContext.
    const documentContext = documentContextSchema.parse({ kind: "snapshot", docs });
    return { content: rewrittenText, documentContext };
  } catch {
    return { content };
  }
}
