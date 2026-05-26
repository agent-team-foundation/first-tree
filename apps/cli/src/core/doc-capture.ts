import { buildMessageDocumentSnapshots, type SelfFence, type WorkspaceFence } from "@first-tree/client";
import { documentContextSchema } from "@first-tree/shared";

/**
 * Snapshot the `.md` documents an outbound `chat send` message references, the
 * same way the runtime's `result-sink` does for an agent's final-text reply
 * (L3: unify doc-preview capture across ALL send paths, not just final-text).
 *
 * The runtime injects the resolved doc context into the agent's environment
 * (`buildAgentEnv`); we read it here so the CLI sub-process resolves against
 * the exact same fence as the runtime — no config reconstruction, no server
 * round-trip.
 *
 * Two wire forms, in priority order:
 *
 *  1. `FIRST_TREE_DOC_AGENT_HOME` (+ optional `_DOC_REPO_LOCAL_PATH`) — the
 *     wide self-fence introduced alongside the worktrees-fence widening. The
 *     full {@link SelfFence} is rebuilt so absolute `.md` paths in the agent's
 *     on-demand `worktrees/<task>/` checkouts also snapshot.
 *
 *  2. `FIRST_TREE_DOC_BASE` (legacy) — set by pre-fix runtimes. We treat it
 *     as `agentHome` so the snapshot pipeline still produces relative-key
 *     output, but no `singleRepoLocalPath` is available so the wider
 *     containment that #498's worktrees idiom relies on is not active. This
 *     branch keeps an old runtime + new chat-send combo working at pre-fix
 *     fidelity (no worktree preview, source-repo paths still resolve).
 *
 * Returns the (possibly rewritten) content + a validated `documentContext` to
 * merge into message metadata. When no doc base is present (not in an agent
 * session) it is a pure pass-through, so `chat send` keeps working unchanged.
 *
 * Capture failure NEVER blocks the send: any error degrades to passing the
 * original content through with no `documentContext`.
 */
export async function captureOutboundDocs(
  content: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ content: string; documentContext?: unknown }> {
  const self = resolveSelfFenceFromEnv(env);
  if (!self) return { content };

  const chatId = env.FIRST_TREE_CHAT_ID;
  const workspacesRoot = env.FIRST_TREE_WORKSPACES_ROOT;
  const selfSlug = env.FIRST_TREE_AGENT_SLUG;
  const fence: WorkspaceFence | undefined =
    workspacesRoot && selfSlug && chatId ? { workspacesRoot, chatId, selfSlug } : undefined;

  try {
    const { docs, rewrittenText } = await buildMessageDocumentSnapshots(content, self, fence);
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

function resolveSelfFenceFromEnv(env: NodeJS.ProcessEnv): SelfFence | null {
  const agentHome = env.FIRST_TREE_DOC_AGENT_HOME;
  if (agentHome) {
    const singleRepoLocalPath = env.FIRST_TREE_DOC_REPO_LOCAL_PATH;
    return singleRepoLocalPath ? { agentHome, singleRepoLocalPath } : { agentHome };
  }
  const legacyBase = env.FIRST_TREE_DOC_BASE;
  return legacyBase ? { agentHome: legacyBase } : null;
}
