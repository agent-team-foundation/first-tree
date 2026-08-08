import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { SessionEvent, ToolFileRef } from "@first-tree/shared";
import type { ContextTreeGitWriteTracker } from "../../runtime/provider-support/index.js";
import {
  resolveContextTreeRelativePath,
  toolFileRefsFromShellCommand,
  withContextTreeRepoHeadCommit,
} from "../../runtime/provider-support/index.js";
import { chunkAssistantText } from "../assistant-text.js";

/**
 * Claude provider-family tool-call processor.
 *
 * Shared by the SDK stream handler (`../claude-code.ts`) and the Claude TUI
 * transcript handler (`../claude-code-tui/index.ts`) — both feed raw provider
 * messages through `createToolCallProcessor` to project Claude's protocol
 * shapes (assistant/user message blocks) onto First Tree `SessionEvent`s.
 * This is provider-protocol → event projection shared across both Claude
 * entry points, not SDK handler lifecycle, so it lives in this provider-family
 * module rather than inside either handler.
 */

const TOOL_RESULT_PREVIEW_LIMIT = 400;

type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content: unknown; is_error?: boolean };
type TextBlock = { type: "text"; text: string };
type ThinkingBlock = { type: "thinking"; thinking?: string };

function extractContentBlocks(message: unknown): unknown[] {
  if (!message || typeof message !== "object") return [];
  const inner = (message as { message?: unknown }).message;
  if (!inner || typeof inner !== "object") return [];
  const content = (inner as { content?: unknown }).content;
  return Array.isArray(content) ? content : [];
}

function isToolUseBlock(block: unknown): block is ToolUseBlock {
  if (!block || typeof block !== "object") return false;
  const b = block as Record<string, unknown>;
  return b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string";
}

function isToolResultBlock(block: unknown): block is ToolResultBlock {
  if (!block || typeof block !== "object") return false;
  const b = block as Record<string, unknown>;
  return b.type === "tool_result" && typeof b.tool_use_id === "string";
}

function isTextBlock(block: unknown): block is TextBlock {
  if (!block || typeof block !== "object") return false;
  const b = block as Record<string, unknown>;
  return b.type === "text" && typeof b.text === "string";
}

function isThinkingBlock(block: unknown): block is ThinkingBlock {
  if (!block || typeof block !== "object") return false;
  const b = block as Record<string, unknown>;
  return b.type === "thinking";
}

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
  }
  return parts.join("\n");
}

/** Tools whose `file_path` / `notebook_path` argument names a single file. */
const TREE_READ_TOOL_NAMES: ReadonlySet<string> = new Set(["Read", "NotebookRead"]);
const TREE_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/**
 * Search/discovery tools scan a search root rather than open one file. They
 * carry directory-level evidence (the explicit `path` argument), deliberately
 * NOT one ref per matched file — a recursive search "touching" every node
 * would drown the Context tab feed in noise.
 */
const TREE_SEARCH_TOOL_NAMES: ReadonlySet<string> = new Set(["Grep", "Glob"]);

/**
 * Extract a string `file_path` argument from a tool_use input, if present.
 * Notebook tools (NotebookRead / NotebookEdit) spell the same argument
 * `notebook_path`; accept either so notebook IO carries refs too.
 */
function readFilePathArg(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const record = input as { file_path?: unknown; notebook_path?: unknown };
  const fp = record.file_path ?? record.notebook_path;
  return typeof fp === "string" ? fp : null;
}

/**
 * If `filePath` lives under `contextTreePath`, return its tree-root-relative
 * path (e.g. `members/Gandy2025/NODE.md`); otherwise null. The agent reads
 * tree files by absolute path (CLAUDE.md points it at the full tree at
 * `contextTreePath`), so a prefix match on the normalised root is the filter.
 * The trailing-slash trim keeps `/a/tree` from matching `/a/tree-other/x`.
 *
 * Invariant: both `filePath` and `contextTreePath` are expected to be
 * absolute. A relative `filePath` will not match the absolute root and returns
 * null — i.e. it silently under-counts (fails safe) rather than mis-attributing.
 *
 * Callers that may receive symlink aliases of the tree (the W1 cloud layout
 * exposes the shared clone as a `<workspace>/context-tree` link) must pass
 * both arguments through `canonicalizeFsPath` first — this function compares
 * strings only.
 */
export function treeNodePathOf(filePath: string, contextTreePath: string): string | null {
  if (!filePath || !contextTreePath) return null;
  const root = contextTreePath.endsWith("/") ? contextTreePath.slice(0, -1) : contextTreePath;
  if (!filePath.startsWith(`${root}/`)) return null;
  const rel = filePath.slice(root.length + 1);
  return rel.length > 0 ? rel : null;
}

/** Local Context Tree repo mapping available to the tool-call processor. */
export type ContextTreeBinding = { path: string | null; repoUrl: string | null; branch?: string | null };

function toolFileRef(toolName: string, input: unknown, contextTree?: ContextTreeBinding): ToolFileRef | null {
  if (!TREE_READ_TOOL_NAMES.has(toolName) && !TREE_WRITE_TOOL_NAMES.has(toolName)) return null;
  const filePath = readFilePathArg(input);
  if (filePath === null) return null;
  // Containment (canonical, symlink-safe) or repo identity (tree PR
  // worktrees — any checkout whose origin remote IS the Context Tree repo).
  // Relative paths keep the fail-safe null mapping — canonicalizing them
  // would resolve against the daemon's cwd and risk mis-attribution.
  const repoRelativePath =
    contextTree && isAbsolute(filePath)
      ? resolveContextTreeRelativePath(filePath, {
          contextTreePath: contextTree.path,
          contextTreeRepoUrl: contextTree.repoUrl,
        })
      : null;
  const ref: ToolFileRef = {
    origin: "tool_arg",
    localPath: filePath,
    pathKind: "file",
    ...(contextTree?.repoUrl && repoRelativePath !== null
      ? {
          repoUrl: contextTree.repoUrl,
          ...(contextTree.branch ? { repoBranch: contextTree.branch } : {}),
          repoRelativePath,
        }
      : {}),
  };
  return TREE_READ_TOOL_NAMES.has(toolName) && isAbsolute(filePath)
    ? withContextTreeRepoHeadCommit(ref, filePath)
    : ref;
}

function statIsFile(absolutePath: string): boolean {
  try {
    return statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

/** Extract a string `path` argument from a search tool_use input, if present. */
function searchPathArg(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const p = (input as { path?: unknown }).path;
  return typeof p === "string" ? p : null;
}

/**
 * Directory-level ref for a Grep/Glob call whose explicit `path` argument
 * targets the Context Tree. Calls without a `path` argument default to the
 * session cwd (the workspace root, not the tree) and carry no ref — fail-safe
 * under-counting over mis-attribution, same stance as `toolFileRef`.
 */
function searchToolFileRef(
  toolName: string,
  input: unknown,
  contextTree: ContextTreeBinding | undefined,
  cwd: string | null | undefined,
): ToolFileRef | null {
  if (!TREE_SEARCH_TOOL_NAMES.has(toolName)) return null;
  const rawPath = searchPathArg(input);
  if (rawPath === null) return null;
  if (!isAbsolute(rawPath) && !cwd) return null;
  const absolutePath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd ?? "", rawPath);
  const repoRelativePath = contextTree
    ? resolveContextTreeRelativePath(absolutePath, {
        contextTreePath: contextTree.path,
        contextTreeRepoUrl: contextTree.repoUrl,
      })
    : null;
  return withContextTreeRepoHeadCommit(
    {
      origin: "tool_arg",
      localPath: absolutePath,
      // Grep accepts a file as its search root; everything else is a directory.
      pathKind: repoRelativePath === "/" ? "repo" : statIsFile(absolutePath) ? "file" : "directory",
      ...(contextTree?.repoUrl && repoRelativePath !== null
        ? {
            repoUrl: contextTree.repoUrl,
            ...(contextTree.branch ? { repoBranch: contextTree.branch } : {}),
            repoRelativePath,
          }
        : {}),
    },
    absolutePath,
  );
}

function readCommandArg(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const command = (input as { command?: unknown }).command;
  return typeof command === "string" ? command : null;
}

function toolFileRefs(
  toolName: string,
  input: unknown,
  contextTree: ContextTreeBinding | undefined,
  cwd: string | null | undefined,
): ToolFileRef[] {
  const directRef = toolFileRef(toolName, input, contextTree);
  if (directRef) return [directRef];
  const searchRef = searchToolFileRef(toolName, input, contextTree, cwd);
  if (searchRef) return [searchRef];
  if (toolName !== "Bash" || !cwd) return [];
  const command = readCommandArg(input);
  if (command === null) return [];
  return toolFileRefsFromShellCommand({
    command,
    cwd,
    contextTreePath: contextTree?.path ?? null,
    contextTreeRepoUrl: contextTree?.repoUrl ?? null,
    contextTreeBranch: contextTree?.branch ?? null,
  });
}

/**
 * Pair `tool_use` (assistant) with `tool_result` (user) blocks and emit a
 * `tool_call` event per pair. Unpaired entries are flushed as `status: "pending"`.
 *
 * Successful single-file read/write tools carry generic `toolFileRefs`
 * evidence. When the local path can be mapped to a known repo checkout, the ref
 * includes repo evidence. The server derives Context Tree IO from that evidence
 * and the actual runtime/tool.
 */
export type ToolCallProcessor = {
  onMessage(message: unknown): void;
  flush(): void;
};

export function createToolCallProcessor(
  emit: (event: SessionEvent) => void,
  contextTree?: ContextTreeBinding,
  options: { cwd?: string | null; gitWriteTracker?: ContextTreeGitWriteTracker } = {},
): ToolCallProcessor {
  type Pending = { toolUseId: string; name: string; args: unknown; startedAt: number };
  const pending = new Map<string, Pending>();

  function pairResult(block: ToolResultBlock): void {
    const entry = pending.get(block.tool_use_id);
    if (!entry) return;
    const status: "ok" | "error" = block.is_error === true ? "error" : "ok";
    const durationMs = Date.now() - entry.startedAt;
    const previewRaw = extractToolResultText(block.content);
    const resultPreview = previewRaw.length > 0 ? previewRaw.slice(0, TOOL_RESULT_PREVIEW_LIMIT) : undefined;
    if (status === "error") options.gitWriteTracker?.captureBaseline();
    const refs = status === "ok" ? toolFileRefs(entry.name, entry.args, contextTree, options.cwd) : [];
    const gitStatusRefs =
      status === "ok"
        ? (options.gitWriteTracker?.refsForSuccessfulToolCall({
            toolName: entry.name,
            toolUseId: entry.toolUseId,
            existingRefs: refs,
          }) ?? [])
        : [];
    const allRefs = [...refs, ...gitStatusRefs];

    emit({
      kind: "tool_call",
      payload: {
        toolUseId: entry.toolUseId,
        name: entry.name,
        args: entry.args,
        status,
        durationMs,
        ...(resultPreview !== undefined ? { resultPreview } : {}),
        ...(allRefs.length > 0 ? { toolFileRefs: allRefs } : {}),
      },
    });

    pending.delete(block.tool_use_id);
  }

  return {
    onMessage(message: unknown): void {
      if (!message || typeof message !== "object") return;
      const type = (message as { type?: unknown }).type;
      if (type === "assistant") {
        for (const block of extractContentBlocks(message)) {
          if (isToolUseBlock(block)) {
            options.gitWriteTracker?.captureBaseline();
            pending.set(block.id, {
              toolUseId: block.id,
              name: block.name,
              args: block.input,
              startedAt: Date.now(),
            });
            // Emit a pending row the moment the tool_use appears — otherwise
            // long-running tools (Bash sleep, network fetches) show nothing
            // live and the chat jumps straight from silence to `used <tool>`
            // after completion. Frontend dedupes by toolUseId against the
            // final ok/error emit (see filterEventsForTimeline).
            emit({
              kind: "tool_call",
              payload: {
                toolUseId: block.id,
                name: block.name,
                args: block.input,
                status: "pending",
              },
            });
          } else if (isTextBlock(block)) {
            const text = block.text.trim();
            if (text.length === 0) continue;
            // Chunk so the FULL assistant text is preserved across one or more
            // events — the durable troubleshooting record now that the
            // per-turn final-text chat mirror is retired.
            for (const chunk of chunkAssistantText(text)) {
              emit({ kind: "assistant_text", payload: { text: chunk } });
            }
          } else if (isThinkingBlock(block)) {
            emit({ kind: "thinking", payload: {} });
          }
        }
      } else if (type === "user") {
        for (const block of extractContentBlocks(message)) {
          if (isToolResultBlock(block)) pairResult(block);
        }
      }
    },
    flush(): void {
      // `pending` rows were already emitted up-front when each tool_use
      // arrived, so flush is now just a bookkeeping reset — no second emit.
      // Unpaired entries stay visible as "pending" in the UI until the next
      // turn_end collapses them with the rest of the abandoned turn.
      pending.clear();
    },
  };
}
