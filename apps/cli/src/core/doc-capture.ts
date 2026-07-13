import {
  buildMessageDocumentSnapshots,
  type FirstTreeHubSDK,
  type SelfFence,
  type WorkspaceFence,
} from "@first-tree/client";
import { type AttachmentRef, documentContextSchema } from "@first-tree/shared";

/**
 * Capture the `.md` documents an outbound `chat send` message references, the
 * same way the runtime's `result-sink` does for an agent's final-text reply
 * (L3: unify doc-preview capture across ALL send paths, not just final-text).
 *
 * Capture now uploads each resolved doc's bytes to the org attachment store and
 * stores a generic `AttachmentRef` (kind: "document") in `metadata.attachments[]`,
 * rewriting the mention into an `[display](attachment:<id>)` link — identical to
 * result-sink. The bytes never travel inside the message.
 *
 * The runtime injects the resolved doc context into the agent's environment
 * (`buildAgentEnv`); we read it here so the CLI sub-process resolves against the
 * exact same fence as the runtime — no config reconstruction. Uploads need an
 * org: it is resolved from the target chat (`getChatDetail`), so capture only
 * runs when a `chatId` is supplied (i.e. `chat send`; `chat create` has no chat
 * yet, so its initial message degrades doc mentions to plain text — KNOWN GAP,
 * out of scope for this PR, tracked as follow-up #1069).
 *
 * Returns the (possibly rewritten) content + the metadata to merge (an
 * `attachments` array and/or a `documentContext` failedMentions roster). When
 * no doc base is present (not in an agent session), or the org can't be
 * resolved, it is a pure pass-through. Capture failure NEVER blocks the send.
 */
export async function captureOutboundDocs(
  content: string,
  ctx: { sdk: FirstTreeHubSDK; chatId?: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ content: string; attachments?: AttachmentRef[]; documentContext?: unknown }> {
  const self = resolveSelfFenceFromEnv(env);
  if (!self || !ctx.chatId) return { content };

  const chatId = ctx.chatId;
  const workspacesRoot = env.FIRST_TREE_WORKSPACES_ROOT;
  const selfSlug = env.FIRST_TREE_AGENT_SLUG;
  const fence: WorkspaceFence | undefined =
    workspacesRoot && selfSlug ? { workspacesRoot, chatId, selfSlug } : undefined;

  try {
    const orgId = await resolveChatOrgId(ctx.sdk, chatId);
    if (!orgId) return { content };
    const { refs, rewrittenText, failedMentions } = await buildMessageDocumentSnapshots(
      content,
      self,
      { uploader: ctx.sdk, orgId },
      fence,
    );
    const result: { content: string; attachments?: AttachmentRef[]; documentContext?: unknown } = {
      content: rewrittenText,
    };
    if (refs.length > 0) result.attachments = refs;
    if (failedMentions.length > 0) {
      result.documentContext = documentContextSchema.parse({ kind: "snapshot", failedMentions });
    }
    return result;
  } catch {
    return { content };
  }
}

/** Shared with `image-capture.ts` so image capture resolves the upload org the
 *  exact same way (from the target chat). */
export async function resolveChatOrgId(sdk: FirstTreeHubSDK, chatId: string): Promise<string | null> {
  try {
    const detail = await sdk.getChatDetail(chatId);
    return typeof detail.organizationId === "string" && detail.organizationId.length > 0 ? detail.organizationId : null;
  } catch {
    return null;
  }
}

/** Shared with `image-capture.ts` so image capture resolves the send-side
 *  workspace fence from the exact same runtime-provided env vars. */
export function resolveSelfFenceFromEnv(env: NodeJS.ProcessEnv): SelfFence | null {
  const agentHome = env.FIRST_TREE_DOC_AGENT_HOME;
  if (agentHome) {
    const singleRepoLocalPath = env.FIRST_TREE_DOC_REPO_LOCAL_PATH;
    return singleRepoLocalPath ? { agentHome, singleRepoLocalPath } : { agentHome };
  }
  const legacyBase = env.FIRST_TREE_DOC_BASE;
  return legacyBase ? { agentHome: legacyBase } : null;
}
