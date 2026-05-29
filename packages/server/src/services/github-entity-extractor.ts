import type { ToolCallEventPayload } from "@first-tree/shared";

/**
 * Phase 1 fallback path for chat ↔ GitHub entity binding.
 *
 * The long-term direction is *not* to extend this whitelist indefinitely —
 * see `first-tree-context:agent-hub/github-entity-chat-binding.md` for the four-family
 * framing (declaration / outbound proxy / webhook backfill / stdout
 * extraction). Stdout extraction is the cheapest first cut, not the
 * canonical entry point; once an explicit `bind_chat_to_github_entity`
 * API lands, prefer adding callers there over expanding this file.
 *
 * Detect "the agent just created a PR or Issue" from a tool_call session
 * event. Phase 1 allowlist only — shell-backed `gh pr create` / `gh issue
 * create`. Claude Code reports shell calls as `Bash`; Codex reports command
 * executions as `command`. These two tools emit a single-line URL on stdout
 * (well under the 400-char `resultPreview` cap), so detection is lossless. curl /
 * GitHub MCP tools are out of scope until Phase 2 (their JSON responses
 * can overflow the preview).
 *
 * Returning a value tells `maybeBindGithubEntityFromToolCall` to write
 * an `agent_created` mapping row so the upcoming `pull_request.opened`
 * / `issues.opened` webhook routes back to the agent's current chat
 * instead of fanning out a fresh one.
 */
export type ExtractedEntity = {
  entityType: "pull_request" | "issue";
  /** Stable cluster key, e.g. `"owner/repo#123"`. */
  entityKey: string;
  entityUrl: string;
  source: "bash-gh-pr" | "bash-gh-issue";
};

const PR_COMMAND_RE = /\bgh\s+pr\s+create\b/;
const ISSUE_COMMAND_RE = /\bgh\s+issue\s+create\b/;
const PR_URL_RE = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/;
const ISSUE_URL_RE = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)/;
const SHELL_TOOL_NAMES = new Set(["Bash", "command"]);

export function extractGithubEntity(payload: ToolCallEventPayload): ExtractedEntity | null {
  if (payload.status !== "ok") return null;
  if (!SHELL_TOOL_NAMES.has(payload.name)) return null;

  const args = payload.args;
  if (typeof args !== "object" || args === null) return null;
  const command = (args as { command?: unknown }).command;
  if (typeof command !== "string") return null;

  const preview = payload.resultPreview ?? "";

  if (PR_COMMAND_RE.test(command)) {
    const m = preview.match(PR_URL_RE);
    if (!m) return null;
    return {
      entityType: "pull_request",
      entityKey: `${m[1]}/${m[2]}#${m[3]}`,
      entityUrl: m[0],
      source: "bash-gh-pr",
    };
  }

  if (ISSUE_COMMAND_RE.test(command)) {
    const m = preview.match(ISSUE_URL_RE);
    if (!m) return null;
    return {
      entityType: "issue",
      entityKey: `${m[1]}/${m[2]}#${m[3]}`,
      entityUrl: m[0],
      source: "bash-gh-issue",
    };
  }

  return null;
}
