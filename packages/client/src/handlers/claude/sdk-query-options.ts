import type { EffortLevel, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRuntimeConfigPayload } from "@first-tree/shared";
import type { ChatContext } from "../../runtime/provider-support/index.js";
import { renderChatContextPrompt, renderRuntimeOutputContract } from "../../runtime/provider-support/index.js";
import { mapMcpServers } from "./mcp-config.js";

/** Payload-derived slice of the Claude Code SDK query options. */
export type ClaudeQueryConfigOptions = {
  model?: string;
  mcpServers?: Record<string, McpServerConfig>;
  effort?: EffortLevel;
  systemPrompt?: {
    type: "preset";
    preset: "claude_code";
    append?: string;
  };
};

/**
 * Build the config-derived slice of the SDK query options (model, MCP
 * servers, reasoning effort). Kept pure and exported so these mappings are
 * unit-testable; the session-bound options (env, canUseTool, abortController,
 * sessionId/resume) stay inline in `buildQuery`.
 *
 * Per-agent prompt instructions, working-directory convention, and source-repo
 * list land in `<cwd>/AGENTS.md` (which `CLAUDE.md` symlinks to). Per-chat
 * Current Chat Context is appended through the SDK `systemPrompt` channel so
 * concurrent chats sharing one agent home cannot overwrite each other's
 * context in the shared briefing file.
 *
 * Reasoning effort: the claude variant's `""` is an inherit sentinel — when
 * set we omit the `effort` option so the SDK falls back to the operator's local
 * `~/.claude/settings.json` effortLevel (preserving pre-feature behavior). A
 * non-empty value is passed explicitly and overrides that local setting.
 */
export function buildClaudeQueryOptions(
  payload: AgentRuntimeConfigPayload | undefined,
  chatContext?: ChatContext,
): ClaudeQueryConfigOptions {
  const options: ClaudeQueryConfigOptions = {};
  if (payload?.model) options.model = payload.model;
  if (payload?.mcpServers.length) options.mcpServers = mapMcpServers(payload);
  if (payload?.kind === "claude-code" && payload.reasoningEffort) {
    options.effort = payload.reasoningEffort;
  }
  // The runtime output contract always rides along (it does not depend on
  // chatContext); the per-chat context block is appended after it when present.
  // Both live in `systemPrompt.append`, which the SDK places after the
  // `claude_code` base preset but at higher salience than the project CLAUDE.md.
  const append = [renderRuntimeOutputContract(), renderChatContextPrompt(chatContext)]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
  if (append) {
    options.systemPrompt = {
      type: "preset",
      preset: "claude_code",
      append,
    };
  }
  return options;
}

/**
 * Decide whether a model swap can use `query.setModel()` (in-flight, ~0ms)
 * vs needing a `resume` restart (~5–10s cold start).
 *
 * "Same family" = model id share the `claude-<family>-<series>` prefix
 * (e.g. `claude-opus-4-5` ↔ `claude-opus-4-6` are same family; `claude-opus-*`
 * ↔ `claude-haiku-*` are not). The SDK's `setModel` handles within-family
 * swaps cleanly; cross-family ones should restart to avoid context-window
 * mismatches.
 */
export function isSameModelFamily(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const segA = a.split("-");
  const segB = b.split("-");
  // claude-<family>-<series>-<rev>
  if (segA.length < 3 || segB.length < 3) return false;
  return segA[0] === segB[0] && segA[1] === segB[1] && segA[2] === segB[2];
}
