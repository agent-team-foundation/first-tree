import { z } from "zod";
import type { runtimeProviderSchema } from "./runtime-provider.js";

/**
 * Agent runtime configuration.
 *
 * Defines the 5 user-tunable field groups that the Hub centrally manages
 * and pushes down to the client runtime: prompt append, model, MCP servers,
 * env vars, and Git repos. Tagged by `kind` (a runtime provider) so future
 * provider-specific fields can land on a dedicated variant.
 *
 * NOTE: do not co-locate with `packages/shared/src/config/` — that namespace
 * is reserved for the local YAML config (`agent.yaml` / server / client) and
 * is unrelated to the Hub-managed runtime config defined here.
 */

const PROMPT_APPEND_MAX_LENGTH = 32_000;
const MCP_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export const promptConfigSchema = z.object({
  append: z.string().max(PROMPT_APPEND_MAX_LENGTH).default(""),
});
export type PromptConfig = z.infer<typeof promptConfigSchema>;

export const mcpStdioServerSchema = z.object({
  name: z.string().regex(MCP_NAME_PATTERN, "MCP name must match /^[a-z0-9][a-z0-9_-]{0,63}$/i"),
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
});
export type McpStdioServer = z.infer<typeof mcpStdioServerSchema>;

export const mcpHttpServerSchema = z.object({
  name: z.string().regex(MCP_NAME_PATTERN, "MCP name must match /^[a-z0-9][a-z0-9_-]{0,63}$/i"),
  transport: z.literal("http"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});
export type McpHttpServer = z.infer<typeof mcpHttpServerSchema>;

export const mcpSseServerSchema = z.object({
  name: z.string().regex(MCP_NAME_PATTERN, "MCP name must match /^[a-z0-9][a-z0-9_-]{0,63}$/i"),
  transport: z.literal("sse"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});
export type McpSseServer = z.infer<typeof mcpSseServerSchema>;

export const mcpServerSchema = z.discriminatedUnion("transport", [
  mcpStdioServerSchema,
  mcpHttpServerSchema,
  mcpSseServerSchema,
]);
export type McpServer = z.infer<typeof mcpServerSchema>;

export const envEntrySchema = z.object({
  key: z.string().regex(ENV_KEY_PATTERN, "Env key must match /^[A-Z][A-Z0-9_]*$/"),
  value: z.string(),
  sensitive: z.boolean().default(false),
});
export type EnvEntry = z.infer<typeof envEntrySchema>;

export const gitRepoSchema = z.object({
  url: z.string().min(1),
  ref: z.string().min(1).optional(),
  /** Path relative to the session working directory; if omitted, derive from repo name. */
  localPath: z.string().min(1).optional(),
});
export type GitRepo = z.infer<typeof gitRepoSchema>;

/**
 * Untagged base shape — 5 user-tunable fields, no `kind` discriminator.
 * Used for `.partial()` derivations on the PATCH side, where `kind` is
 * pinned to `agents.runtime_provider` and never changes via config PATCH.
 * Zod 4 forbids `.partial()` on a refined object, so we keep refinements
 * on the tagged schema below.
 */
export const agentRuntimeConfigPayloadShape = z.object({
  prompt: promptConfigSchema.default({ append: "" }),
  /**
   * Model identifier. Accepts either an alias (`opus` / `sonnet` / `haiku`) or
   * a full model id (`claude-opus-4-7`). Alias follows the SDK's latest-in-family
   * mapping and may shift across CLI releases; pin a full id if you need stability.
   */
  model: z.string().default("opus"),
  mcpServers: z.array(mcpServerSchema).default([]),
  env: z.array(envEntrySchema).default([]),
  gitRepos: z.array(gitRepoSchema).default([]),
});

/**
 * Tagged variants — read-side, full payload including `kind`. Adding a new
 * provider means adding a variant here, plus a handler factory and a
 * capability probe module on the client side.
 *
 * Provider-specific fields (e.g. codex `sandboxMode`) belong on the
 * matching variant, not on the base shape.
 */
const claudeRuntimeConfigPayloadShape = agentRuntimeConfigPayloadShape.extend({
  kind: z.literal("claude-code"),
});
const codexRuntimeConfigPayloadShape = agentRuntimeConfigPayloadShape.extend({
  kind: z.literal("codex"),
});

const taggedPayloadUnion = z.discriminatedUnion("kind", [
  claudeRuntimeConfigPayloadShape,
  codexRuntimeConfigPayloadShape,
]);
type TaggedPayload = z.infer<typeof taggedPayloadUnion>;

const payloadDuplicatesRefinement = (payload: TaggedPayload, ctx: z.RefinementCtx) => {
  const seenMcp = new Set<string>();
  payload.mcpServers.forEach((server, idx) => {
    const lower = server.name.toLowerCase();
    if (seenMcp.has(lower)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mcpServers", idx, "name"],
        message: `Duplicate MCP server name "${server.name}"`,
      });
    }
    seenMcp.add(lower);
  });

  const seenEnv = new Set<string>();
  payload.env.forEach((entry, idx) => {
    if (seenEnv.has(entry.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["env", idx, "key"],
        message: `Duplicate env key "${entry.key}"`,
      });
    }
    seenEnv.add(entry.key);
  });

  const seenPaths = new Set<string>();
  payload.gitRepos.forEach((repo, idx) => {
    const path = repo.localPath ?? deriveRepoLocalPath(repo.url);
    if (!path) return;
    if (seenPaths.has(path)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["gitRepos", idx, "localPath"],
        message: `Duplicate git repo local path "${path}"`,
      });
    }
    seenPaths.add(path);
  });
};

/**
 * Read-side full payload schema. Rows persisted before 0026 do not carry
 * `kind`; `z.preprocess` injects `"claude-code"` so they parse cleanly into
 * the claude variant. The service layer separately enforces
 * `payload.kind === agents.runtime_provider` on writes.
 */
export const agentRuntimeConfigPayloadSchema = z
  .preprocess((input) => {
    if (
      input &&
      typeof input === "object" &&
      !Array.isArray(input) &&
      !("kind" in (input as Record<string, unknown>))
    ) {
      return { ...(input as Record<string, unknown>), kind: "claude-code" };
    }
    return input;
  }, taggedPayloadUnion)
  .superRefine((payload, ctx) => {
    payloadDuplicatesRefinement(payload as TaggedPayload, ctx);
  });
export type AgentRuntimeConfigPayload = z.infer<typeof agentRuntimeConfigPayloadSchema>;

/** Default payload used when creating a fresh claude-code agent. */
export const DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD: AgentRuntimeConfigPayload = {
  kind: "claude-code",
  prompt: { append: "" },
  model: "opus",
  mcpServers: [],
  env: [],
  gitRepos: [],
};

/**
 * Default payload for a fresh codex agent. Same 5 fields as claude-code.
 * `model` is left empty by default so the Codex CLI picks one matching the
 * user's auth mode — `gpt-5-codex` is rejected by ChatGPT-account auth, while
 * an empty string lets the SDK fall through to its built-in default.
 */
export const DEFAULT_CODEX_RUNTIME_CONFIG_PAYLOAD: AgentRuntimeConfigPayload = {
  kind: "codex",
  prompt: { append: "" },
  model: "",
  mcpServers: [],
  env: [],
  gitRepos: [],
};

/**
 * Default payload selector by runtime provider.
 */
export function defaultRuntimeConfigPayload(
  provider: z.infer<typeof runtimeProviderSchema>,
): AgentRuntimeConfigPayload {
  switch (provider) {
    case "codex":
      return { ...DEFAULT_CODEX_RUNTIME_CONFIG_PAYLOAD };
    case "claude-code":
      return { ...DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD };
    default: {
      const _exhaustive: never = provider;
      void _exhaustive;
      return { ...DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD };
    }
  }
}

export const agentRuntimeConfigSchema = z.object({
  agentId: z.string(),
  version: z.number().int().positive(),
  payload: agentRuntimeConfigPayloadSchema,
  updatedAt: z.string(),
  updatedBy: z.string(),
});
export type AgentRuntimeConfig = z.infer<typeof agentRuntimeConfigSchema>;

/**
 * Write-side shape with no `.default()` per field.
 *
 * `agentRuntimeConfigPayloadShape` carries `.default()` on every field for the
 * read path (so legacy DB rows parse cleanly). On the PATCH side those defaults
 * are actively harmful: Zod 4's `.partial()` makes a field optional but keeps
 * the inner `ZodDefault`, so a body like `{ mcpServers: [...] }` parses to a
 * fully-populated patch where the omitted fields are filled with their
 * defaults — the service layer's `patch.x ?? current.x` then sees a truthy
 * default and *replaces* the user's saved value with empty. Mirroring the 5
 * fields here without defaults keeps "field absent" → `undefined` in the
 * parsed patch, which is what the merge logic expects.
 */
const agentRuntimeConfigPatchShape = z
  .object({
    prompt: promptConfigSchema,
    model: z.string(),
    mcpServers: z.array(mcpServerSchema),
    env: z.array(envEntrySchema),
    gitRepos: z.array(gitRepoSchema),
  })
  .partial();

/**
 * Patch payload for PATCH /api/v1/admin/agents/:uuid/config.
 *
 * - `expectedVersion` enforces optimistic locking; mismatch → 409.
 * - All payload fields are optional; omitted fields are left untouched.
 */
export const updateAgentRuntimeConfigSchema = z.object({
  expectedVersion: z.number().int().positive(),
  payload: agentRuntimeConfigPatchShape,
});
export type UpdateAgentRuntimeConfig = z.infer<typeof updateAgentRuntimeConfigSchema>;

export const dryRunAgentRuntimeConfigSchema = z.object({
  payload: agentRuntimeConfigPatchShape,
});
export type DryRunAgentRuntimeConfig = z.infer<typeof dryRunAgentRuntimeConfigSchema>;

export const agentRuntimeConfigDryRunResultSchema = z.object({
  current: agentRuntimeConfigSchema,
  next: agentRuntimeConfigPayloadSchema,
  diff: z.array(
    z.object({
      path: z.string(),
      op: z.enum(["add", "remove", "replace"]),
      before: z.unknown().optional(),
      after: z.unknown().optional(),
    }),
  ),
});
export type AgentRuntimeConfigDryRunResult = z.infer<typeof agentRuntimeConfigDryRunResultSchema>;

/**
 * Branded payload sent over the wire to the client runtime.
 *
 * `__brand` prevents accidentally serialising raw DB rows / inbox entries —
 * every dispatch path must go through `buildClientMessagePayload` (Step 3).
 */
export type ClientMessagePayload = {
  readonly __brand: "client-message-payload";
  messageId: string;
  chatId: string;
  inboxId: string;
  senderId: string | null;
  format: string;
  content: unknown;
  createdAt: string;
  configVersion: number;
};

export const ENV_REDACTED_PLACEHOLDER = "***";

/** Mask of a previously-stored sensitive value when echoing back to admin. */
export function isRedactedEnvValue(value: string): boolean {
  return value === ENV_REDACTED_PLACEHOLDER;
}

/**
 * Derive a default local path from a repo URL.
 * Used both for validation (duplicate detection) and at runtime when the user
 * leaves `localPath` empty.
 */
export function deriveRepoLocalPath(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  const noQuery = trimmed.split(/[?#]/)[0] ?? "";
  const lastSegment = noQuery.split(/[/:]/).filter(Boolean).pop() ?? "";
  return lastSegment.replace(/\.git$/i, "");
}
