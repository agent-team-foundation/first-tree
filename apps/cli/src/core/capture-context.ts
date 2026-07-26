import type { FirstTreeHubSDK, SelfFence } from "@first-tree/client";

/**
 * Send-time capture context shared by document capture (`doc-capture.ts`) and
 * image capture (`image-capture.ts`): resolving the sender's workspace fence
 * from the runtime-injected env and the upload org from the target chat.
 *
 * These live in their own module (not on `doc-capture.ts`) so that a test which
 * `vi.mock`s `doc-capture.js` does not knock out `image-capture.js`'s imports —
 * the two capture modules must not be coupled through each other's module
 * surface.
 */

/** Resolve the upload org from the target chat (attachments are org-scoped). */
export async function resolveChatOrgId(sdk: FirstTreeHubSDK, chatId: string): Promise<string | null> {
  try {
    const detail = await sdk.getChatDetail(chatId);
    return typeof detail.organizationId === "string" && detail.organizationId.length > 0 ? detail.organizationId : null;
  } catch {
    return null;
  }
}

/** Resolve the send-side workspace fence from the runtime-provided env vars. */
export function resolveSelfFenceFromEnv(env: NodeJS.ProcessEnv): SelfFence | null {
  const agentHome = env.FIRST_TREE_DOC_AGENT_HOME;
  if (agentHome) {
    const singleRepoLocalPath = env.FIRST_TREE_DOC_REPO_LOCAL_PATH;
    return singleRepoLocalPath ? { agentHome, singleRepoLocalPath } : { agentHome };
  }
  const legacyBase = env.FIRST_TREE_DOC_BASE;
  return legacyBase ? { agentHome: legacyBase } : null;
}

/**
 * Image embeds are authored directly in an agent turn, so their relative paths
 * are workspace-relative. Keep the document capture's optional repo base out
 * of this fence: generated screenshots commonly live beside `source-repos/`,
 * and an agent-managed source repository may be bare.
 */
export function resolveImageFenceFromEnv(env: NodeJS.ProcessEnv): SelfFence | null {
  const agentHome = env.FIRST_TREE_DOC_AGENT_HOME;
  if (agentHome) return { agentHome };
  const legacyBase = env.FIRST_TREE_DOC_BASE;
  return legacyBase ? { agentHome: legacyBase } : null;
}
