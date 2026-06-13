import { z } from "zod";
import {
  getRepoLocalPathSafetyError,
  gitRepoSchema,
  mcpStdioServerSchema,
  normalizeRepoLocalPath,
  PROMPT_APPEND_MAX_LENGTH,
} from "./agent-runtime-config.js";
import { repoUrlSchema } from "./org-settings.js";

export const RESOURCE_TYPES = {
  REPO: "repo",
  PROMPT: "prompt",
  SKILL: "skill",
  MCP: "mcp",
} as const;

export const resourceTypeSchema = z.enum(["repo", "prompt", "skill", "mcp"]);
export type ResourceType = z.infer<typeof resourceTypeSchema>;

export const RESOURCE_SCOPES = {
  TEAM: "team",
  AGENT: "agent",
} as const;

export const resourceScopeSchema = z.enum(["team", "agent"]);
export type ResourceScope = z.infer<typeof resourceScopeSchema>;

export const RESOURCE_DEFAULT_ENABLED = {
  RECOMMENDED: "recommended",
  AVAILABLE: "available",
} as const;

export const resourceDefaultEnabledSchema = z.enum(["recommended", "available"]);
export type ResourceDefaultEnabled = z.infer<typeof resourceDefaultEnabledSchema>;

export const RESOURCE_STATUSES = {
  ACTIVE: "active",
  STALE: "stale",
  RETIRED: "retired",
} as const;

export const resourceStatusSchema = z.enum(["active", "stale", "retired"]);
export type ResourceStatus = z.infer<typeof resourceStatusSchema>;

export const AGENT_RESOURCE_BINDING_MODES = {
  INCLUDE: "include",
  DISABLE: "disable",
  REPLACE: "replace",
} as const;

export const agentResourceBindingModeSchema = z.enum(["include", "disable", "replace"]);
export type AgentResourceBindingMode = z.infer<typeof agentResourceBindingModeSchema>;

export const EFFECTIVE_RESOURCE_SOURCES = {
  TEAM_RECOMMENDED: "team_recommended",
  TEAM_AVAILABLE: "team_available",
  AGENT_EXTRA: "agent_extra",
  INLINE_PROMPT: "inline_prompt",
} as const;

export const effectiveResourceSourceSchema = z.enum([
  "team_recommended",
  "team_available",
  "agent_extra",
  "inline_prompt",
]);
export type EffectiveResourceSource = z.infer<typeof effectiveResourceSourceSchema>;

export const repoResourcePayloadSchema = z.object({
  url: repoUrlSchema,
  defaultBranch: z.string().min(1).optional(),
});
export type RepoResourcePayload = z.infer<typeof repoResourcePayloadSchema>;

export const promptResourcePayloadSchema = z.object({
  body: z.string().max(32 * 1024),
  description: z.string().max(1000).optional(),
});
export type PromptResourcePayload = z.infer<typeof promptResourcePayloadSchema>;

export const skillResourcePayloadSchema = z.object({
  name: z.string().min(1).max(100),
  namespace: z.string().min(1).max(100).optional(),
  description: z.string().min(1).max(1000),
  body: z.string().max(64 * 1024),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type SkillResourcePayload = z.infer<typeof skillResourcePayloadSchema>;

const mcpHttpNoSecretServerSchema = z
  .object({
    name: z.string().min(1),
    transport: z.literal("http"),
    url: z.string().url().refine(hasNoUrlCredentials, "MCP resource URLs must not include credentials."),
  })
  .strict();

const mcpSseNoSecretServerSchema = z
  .object({
    name: z.string().min(1),
    transport: z.literal("sse"),
    url: z.string().url().refine(hasNoUrlCredentials, "MCP resource URLs must not include credentials."),
  })
  .strict();

export const noSecretMcpServerSchema = z.discriminatedUnion("transport", [
  mcpStdioServerSchema.strict(),
  mcpHttpNoSecretServerSchema,
  mcpSseNoSecretServerSchema,
]);
export type NoSecretMcpServer = z.infer<typeof noSecretMcpServerSchema>;

export const resourcePayloadSchema = z.union([
  repoResourcePayloadSchema,
  promptResourcePayloadSchema,
  skillResourcePayloadSchema,
  noSecretMcpServerSchema,
]);
export type ResourcePayload = z.infer<typeof resourcePayloadSchema>;

function hasNoUrlCredentials(value: string): boolean {
  const parsed = new URL(value);
  return parsed.username === "" && parsed.password === "";
}

const namedResourceInputShape = {
  name: z.string().min(1).max(200),
  defaultEnabled: resourceDefaultEnabledSchema.default("available"),
} as const;

export const createTeamResourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("repo"),
    ...namedResourceInputShape,
    payload: repoResourcePayloadSchema,
  }),
  z.object({
    type: z.literal("prompt"),
    ...namedResourceInputShape,
    payload: promptResourcePayloadSchema,
  }),
  z.object({
    type: z.literal("skill"),
    ...namedResourceInputShape,
    payload: skillResourcePayloadSchema,
  }),
  z.object({
    type: z.literal("mcp"),
    ...namedResourceInputShape,
    payload: noSecretMcpServerSchema,
  }),
]);
export type CreateTeamResource = z.infer<typeof createTeamResourceSchema>;

export const updateTeamResourceSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  defaultEnabled: resourceDefaultEnabledSchema.optional(),
  status: resourceStatusSchema.optional(),
  payload: z.unknown().optional(),
});
export type UpdateTeamResource = z.infer<typeof updateTeamResourceSchema>;

export const resourceImpactPreviewSchema = z.object({
  resourceId: z.string().min(1).optional(),
  type: resourceTypeSchema.optional(),
  defaultEnabled: resourceDefaultEnabledSchema.optional(),
  payload: z.unknown().optional(),
});
export type ResourceImpactPreview = z.infer<typeof resourceImpactPreviewSchema>;

export const agentExtraRepoInputSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  url: repoUrlSchema,
  defaultBranch: z.string().min(1).optional(),
});
export type AgentExtraRepoInput = z.infer<typeof agentExtraRepoInputSchema>;

export const agentResourceBindingInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    type: resourceTypeSchema,
    mode: agentResourceBindingModeSchema,
    resourceId: z.string().min(1).nullable().optional(),
    replacesResourceId: z.string().min(1).nullable().optional(),
    inlinePromptBody: z
      .string()
      .max(32 * 1024)
      .nullable()
      .optional(),
    agentExtraRepo: agentExtraRepoInputSchema.optional(),
    repoRef: z.string().min(1).nullable().optional(),
    repoLocalPath: z
      .string()
      .min(1)
      // Collapse a legacy clean nested path to its basename before validating,
      // so a persisted nested binding reads cleanly (see normalizeRepoLocalPath).
      .transform(normalizeRepoLocalPath)
      .superRefine((value, ctx) => {
        const err = getRepoLocalPathSafetyError(value);
        if (!err) return;
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
      })
      .nullable()
      .optional(),
    order: z.number().int().min(0).optional(),
  })
  .superRefine((row, ctx) => {
    const hasResource = !!row.resourceId;
    const hasInlinePrompt = !!row.inlinePromptBody;
    const hasAgentRepo = !!row.agentExtraRepo;

    if (row.type !== "prompt" && hasInlinePrompt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["inlinePromptBody"],
        message: "Only prompt bindings may use inlinePromptBody.",
      });
    }
    if (row.type !== "repo" && hasAgentRepo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["agentExtraRepo"],
        message: "Only repo bindings may create an agent extra repo.",
      });
    }
    if (row.type !== "repo" && (row.repoRef || row.repoLocalPath)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["repoRef"],
        message: "Only repo bindings may set repoRef or repoLocalPath.",
      });
    }
    if (row.mode === "disable") {
      if (!hasResource || row.replacesResourceId || hasInlinePrompt || hasAgentRepo) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Disable bindings must reference exactly one Team resource.",
        });
      }
      return;
    }
    if (row.mode === "replace") {
      if (!row.replacesResourceId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["replacesResourceId"],
          message: "Replace bindings must identify the Team resource being replaced.",
        });
      }
      if (row.type === "prompt") {
        const replacementCount = Number(hasResource) + Number(hasInlinePrompt);
        if (replacementCount !== 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Prompt replace must use either resourceId or inlinePromptBody, but not both.",
          });
        }
      } else if (!hasResource || hasInlinePrompt || hasAgentRepo) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Non-prompt replace bindings must reference a replacement resource.",
        });
      }
      return;
    }
    const includeCount = Number(hasResource) + Number(hasInlinePrompt) + Number(hasAgentRepo);
    if (includeCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Include bindings must use exactly one of resourceId, inlinePromptBody, or agentExtraRepo.",
      });
    }
    if (row.replacesResourceId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["replacesResourceId"],
        message: "Include bindings cannot set replacesResourceId.",
      });
    }
  });
export type AgentResourceBindingInput = z.infer<typeof agentResourceBindingInputSchema>;

export const updateAgentResourcesSchema = z.object({
  expectedVersion: z.number().int().positive(),
  bindings: z.array(agentResourceBindingInputSchema),
});
export type UpdateAgentResources = z.infer<typeof updateAgentResourcesSchema>;

export const resourceRowSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  type: resourceTypeSchema,
  scope: resourceScopeSchema,
  ownerAgentId: z.string().nullable(),
  name: z.string(),
  repoCanonicalKey: z.string().nullable(),
  defaultEnabled: resourceDefaultEnabledSchema.nullable(),
  status: resourceStatusSchema,
  payload: z.unknown(),
  createdBy: z.string(),
  updatedBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ResourceRow = z.infer<typeof resourceRowSchema>;

export const effectiveResourceRowSchema = z.object({
  id: z.string(),
  bindingId: z.string().nullable(),
  resourceId: z.string().nullable(),
  replacesResourceId: z.string().nullable(),
  type: resourceTypeSchema,
  name: z.string(),
  scope: resourceScopeSchema.nullable(),
  source: effectiveResourceSourceSchema,
  mode: z.enum(["enabled", "disabled", "replaced", "unavailable"]),
  defaultEnabled: resourceDefaultEnabledSchema.nullable(),
  payload: z.unknown().nullable(),
  repo: gitRepoSchema.nullable(),
  promptBody: z.string().nullable(),
  unavailableReason: z.string().nullable(),
  order: z.number().int(),
});
export type EffectiveResourceRow = z.infer<typeof effectiveResourceRowSchema>;

export const effectiveAgentResourcesSchema = z.object({
  version: z.number().int().positive(),
  repos: z.array(effectiveResourceRowSchema),
  prompts: z.array(effectiveResourceRowSchema),
  skills: z.array(effectiveResourceRowSchema),
  mcp: z.array(effectiveResourceRowSchema),
  unavailable: z.array(
    z.object({
      type: resourceTypeSchema,
      id: z.string(),
      reason: z.string(),
    }),
  ),
});
export type EffectiveAgentResources = z.infer<typeof effectiveAgentResourcesSchema>;

export const agentResourcesOutputSchema = z.object({
  version: z.number().int().positive(),
  effective: effectiveAgentResourcesSchema,
  bindings: z.array(agentResourceBindingInputSchema),
  availableTeamResources: z.array(resourceRowSchema),
});
export type AgentResourcesOutput = z.infer<typeof agentResourcesOutputSchema>;

export const resourceUsageOutputSchema = z.object({
  resourceId: z.string(),
  agentCount: z.number().int().min(0),
  agents: z.array(
    z.object({
      uuid: z.string(),
      name: z.string().nullable(),
      displayName: z.string(),
    }),
  ),
});
export type ResourceUsageOutput = z.infer<typeof resourceUsageOutputSchema>;

export const resourceImpactPreviewOutputSchema = z.object({
  affectedAgentCount: z.number().int().min(0),
  promptOverflowAgentCount: z.number().int().min(0),
  agents: z.array(
    z.object({
      uuid: z.string(),
      name: z.string().nullable(),
      displayName: z.string(),
    }),
  ),
});
export type ResourceImpactPreviewOutput = z.infer<typeof resourceImpactPreviewOutputSchema>;

export function canonicalizeResourceRepoUrl(url: string): string {
  if (!url.includes("://")) {
    const scpLike = parseScpLikeRepoUrl(url);
    if (scpLike) {
      const { host, rawPath } = scpLike;
      return buildCanonicalRepoKey(host, "", rawPath);
    }
  }

  const parsed = new URL(url);
  const portIsDefault =
    parsed.port === "" ||
    (parsed.protocol === "https:" && parsed.port === "443") ||
    (parsed.protocol === "ssh:" && parsed.port === "22");
  const port = portIsDefault ? "" : parsed.port;
  return buildCanonicalRepoKey(parsed.hostname, port, parsed.pathname);
}

function parseScpLikeRepoUrl(url: string): { host: string; rawPath: string } | null {
  const colonIndex = url.indexOf(":");
  if (colonIndex <= 0 || colonIndex === url.length - 1) {
    return null;
  }

  const hostPart = url.slice(0, colonIndex);
  const rawPath = url.slice(colonIndex + 1);
  const atIndex = hostPart.lastIndexOf("@");
  const host = atIndex >= 0 ? hostPart.slice(atIndex + 1) : hostPart;
  if (!host || !rawPath || rawPath.includes("@") || rawPath.includes(":") || containsWhitespace(rawPath)) {
    return null;
  }

  const firstPathChar = rawPath[0];
  if (!firstPathChar || firstPathChar === "/" || firstPathChar === " ") {
    return null;
  }
  // Avoid treating URL strings like "http://..." fallback errors or "host:22/path" as scp-like repos.
  if (isAsciiDigit(firstPathChar) && (rawPath.length === 1 || rawPath[1] === "/")) {
    return null;
  }

  return { host, rawPath };
}

function buildCanonicalRepoKey(hostname: string, port: string, rawPath: string): string {
  const host = hostname.toLowerCase();
  const hostPort = port ? `${host}:${port}` : host;
  const normalizedPath = stripGitSuffix(trimSlashes(rawPath));
  if (host === "github.com") {
    const segments = normalizedPath.split("/").filter(Boolean);
    if (segments.length >= 2) {
      return `${hostPort}/${segments[0]?.toLowerCase()}/${segments[1]?.toLowerCase()}`;
    }
  }
  return `${hostPort}/${normalizedPath}`;
}

function trimSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "/") {
    start += 1;
  }
  while (end > start && value[end - 1] === "/") {
    end -= 1;
  }
  return value.slice(start, end);
}

function stripGitSuffix(value: string): string {
  return value.toLowerCase().endsWith(".git") ? value.slice(0, -4) : value;
}

function containsWhitespace(value: string): boolean {
  for (const char of value) {
    if (char.trim() === "") {
      return true;
    }
  }
  return false;
}

function isAsciiDigit(value: string): boolean {
  return value >= "0" && value <= "9";
}

export function validateEffectivePromptLength(value: string): boolean {
  return value.length <= PROMPT_APPEND_MAX_LENGTH;
}
