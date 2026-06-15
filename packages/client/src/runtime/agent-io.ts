import {
  type ChatParticipantDetail,
  extractCaption,
  type ImageRefContent,
  isImageBatchRefContent,
  isImageRefContent,
} from "@first-tree/shared";
import type { FirstTreeHubSDK } from "../sdk.js";
import type { AgentIdentity, SessionMessage } from "./handler.js";
import { findImagePath } from "./image-store.js";

/**
 * Cross-handler plumbing for First Tree ↔ agent-runtime interaction.
 *
 * Every handler that shells out to the First Tree CLI or otherwise acts
 * on behalf of the agent needs the same envelope variables (server URL, agent
 * id, inbox id, chat id). And every handler that hands inbound messages to an
 * LLM benefits from the same `[From: <name>]` attribution header so the LLM
 * can see who authored each message in human-readable terms.
 *
 * Keeping these helpers in one place means adding a second handler (Gemini,
 * Cursor Agent, custom LLM, …) does not reimplement either concern.
 */

/**
 * Build the env for CLI sub-processes that need to call `<binName> ...`.
 * Layers the First Tree envelope variables on top of the parent env. Handlers
 * that start sub-processes should call this so every one of them sees the
 * same envelope — enabling replyTo inference, access-token propagation, and
 * agent-id binding without per-handler duplication.
 */
export function buildAgentEnv(
  parentEnv: NodeJS.ProcessEnv,
  ctx: {
    sdk: Pick<FirstTreeHubSDK, "serverUrl">;
    agent: AgentIdentity;
    chatId: string;
    /**
     * Resolved doc-preview context for this session, so a `first-tree
     * chat send` sub-process can snapshot referenced `.md` the same way
     * `result-sink` does for final-text (L3: unify capture across send
     * paths). Absent → `chat send` skips snapshotting.
     *
     * Two boundaries are exported:
     *  - `agentHome` — the WIDE fence: per-agent home (or legacy per-chat
     *    dir for pre-#506 chats). Covers on-demand `worktrees/<task>/`
     *    checkouts that #498's idiom puts here. New chat-send binaries read
     *    `FIRST_TREE_DOC_AGENT_HOME`.
     *  - `base` — the NARROW fence: source repo top
     *    (`<agentHome>/source-repos/<localPath>` for single-repo, `agentHome`
     *    otherwise). Kept emitting under the
     *    legacy `FIRST_TREE_DOC_BASE` name so a stale pre-fix `chat send`
     *    binary still snapshots like it used to (graceful degradation: no
     *    worktree preview, but source-repo docs work).
     *
     * Cross-agent resolution needs `workspacesRoot` + `selfSlug` + chatId;
     * `agentHome` alone (or `base` alone for legacy) still enables self
     * snapshots.
     */
    docContext?: {
      /** Legacy narrow fence (source-repo top); ridden by pre-fix `chat send`. */
      base: string;
      /** Wide fence (agent home / legacy per-chat dir). */
      agentHome: string;
      /** Single declared source-repo `localPath` — promotes relative `docs/foo.md`
       *  to the same canonical key as the absolute form. */
      singleRepoLocalPath?: string;
      workspacesRoot: string;
      selfSlug: string;
    };
  },
): NodeJS.ProcessEnv {
  return {
    ...parentEnv,
    FIRST_TREE_SERVER_URL: ctx.sdk.serverUrl,
    FIRST_TREE_AGENT_ID: ctx.agent.agentId,
    FIRST_TREE_INBOX_ID: ctx.agent.inboxId,
    FIRST_TREE_CHAT_ID: ctx.chatId,
    ...(ctx.docContext
      ? {
          FIRST_TREE_DOC_BASE: ctx.docContext.base,
          FIRST_TREE_DOC_AGENT_HOME: ctx.docContext.agentHome,
          ...(ctx.docContext.singleRepoLocalPath
            ? { FIRST_TREE_DOC_REPO_LOCAL_PATH: ctx.docContext.singleRepoLocalPath }
            : {}),
          FIRST_TREE_WORKSPACES_ROOT: ctx.docContext.workspacesRoot,
          FIRST_TREE_AGENT_SLUG: ctx.docContext.selfSlug,
        }
      : {}),
  };
}

/** Session-scoped participant cache shared by result-sink and inbound formatter. */
export type ParticipantCache = {
  get: () => Promise<ChatParticipantDetail[]>;
};

export function createParticipantCache(
  sdk: Pick<FirstTreeHubSDK, "listChatParticipants">,
  chatId: string,
  log: (msg: string) => void,
): ParticipantCache {
  let cached: ChatParticipantDetail[] | null = null;
  let inflight: Promise<ChatParticipantDetail[]> | null = null;
  return {
    async get() {
      if (cached) return cached;
      if (!inflight) {
        inflight = (async () => {
          try {
            const rows = await sdk.listChatParticipants(chatId);
            cached = rows;
            return rows;
          } catch (err) {
            log(`listChatParticipants failed: ${err instanceof Error ? err.message : String(err)}`);
            return [];
          } finally {
            inflight = null;
          }
        })();
      }
      return inflight;
    },
  };
}

/**
 * Resolve `senderId` → display-friendly label the LLM can actually
 * disambiguate. Prefers `name` (unique per chat, used as the `@<name>`
 * mention token), falls back to `displayName`, then to the raw id. The last
 * fallback matters for edge cases — e.g. a participant removed mid-session
 * after we cached an earlier participants snapshot.
 */
export function resolveSenderLabel(senderId: string, participants: ChatParticipantDetail[]): string {
  for (const p of participants) {
    if (p.agentId !== senderId) continue;
    if (p.name) return p.name;
    if (p.displayName) return p.displayName;
    return senderId;
  }
  return senderId;
}

/**
 * Produce the handler-facing string form of an inbound message. Prefixes a
 * `[From: <name>]` line when the sender is a known participant. Structured
 * content is serialised to JSON — handlers that want to feed structured
 * content some other way should opt out and format themselves.
 *
 * If the server attached `precedingMessages` (silent group-chat history the
 * recipient missed because it was `mention_only` and not @mentioned), prepend
 * them under an `[Earlier in chat]` block so the LLM sees what came before
 * the @mention that woke this turn — see proposals/group-chat-ux-improvements §1.
 *
 * Async because the participant list may need a server round-trip on first
 * use; subsequent messages in the same session hit the cache.
 */
/**
 * Convert a SessionMessage's payload to a plain-text snippet the LLM can
 * read as user input. Most formats are already strings; non-string
 * payloads are stringified so the resumed turn still sees readable text.
 *
 * `format: "file"` image messages (single-ref or batched caption + N refs)
 * get a human-readable rendering — caption text plus the on-disk path of
 * each image so a shell-capable LLM (codex CLI, claude-code) can read it,
 * or a "[Image … not available on this device]" placeholder when the bytes
 * never arrived on this client. Without this, codex / future handlers that
 * delegate to `formatInboundContent` would see the raw `{caption,
 * attachments}` JSON.
 */
function renderForLLM(message: SessionMessage): string {
  if (typeof message.content === "string") return message.content;
  if (message.format === "file") {
    const rendered = renderFileMessageForLLM(message);
    if (rendered !== null) return rendered;
  }
  return JSON.stringify(message.content);
}

/** Return a text rendering for a file message's content, or null when the
 * shape isn't a known image variant — caller falls back to JSON. */
function renderFileMessageForLLM(message: SessionMessage): string | null {
  const content = message.content;

  // Batch shape: caption + N image refs.
  if (isImageBatchRefContent(content)) {
    const attachments: readonly ImageRefContent[] = content.attachments;
    const caption = extractCaption(content).trim();
    const lines: string[] = [];
    if (caption.length > 0) lines.push(caption);
    lines.push(
      attachments.length === 1
        ? "An image was shared in this chat. Use the Read tool / shell to open it before responding."
        : `${attachments.length} images were shared in this chat. Use the Read tool / shell to open each before responding.`,
    );
    for (const att of attachments) {
      const path = findImagePath(message.chatId, att.imageId, att.mimeType);
      lines.push(
        path
          ? `\nFilename: ${att.filename}\nPath: ${path}`
          : `\n[Image "${att.filename}" not available on this device]`,
      );
    }
    return lines.join("\n");
  }

  // Single image ref (pre-batch shape, kept for backward compatibility).
  if (isImageRefContent(content)) {
    const path = findImagePath(message.chatId, content.imageId, content.mimeType);
    return path
      ? `An image was shared in this chat. Use the Read tool / shell to open it before responding.\n\nFilename: ${content.filename}\nPath: ${path}`
      : `[Image "${content.filename}" not available on this device]`;
  }

  return null;
}

export async function formatInboundContent(message: SessionMessage, participants: ParticipantCache): Promise<string> {
  const rawContent = renderForLLM(message);
  const preceding = message.precedingMessages ?? [];

  let header = "";
  if (preceding.length > 0) {
    const ps = await participants.get();
    const lines: string[] = ["[Earlier in chat — context you missed]"];
    for (const p of preceding) {
      const label = resolveSenderLabel(p.senderId, ps);
      const text = typeof p.content === "string" ? p.content : JSON.stringify(p.content);
      lines.push(`[From: ${label}] ${text}`);
    }
    lines.push("", "[Now — message that woke you]");
    header = `${lines.join("\n")}\n\n`;
  }

  if (!message.senderId) return `${header}${rawContent}`;
  const label = resolveSenderLabel(message.senderId, await participants.get());
  return `${header}[From: ${label}]\n\n${rawContent}`;
}
