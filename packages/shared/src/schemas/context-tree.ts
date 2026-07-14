import { z } from "zod";
import { contextTreeRepoSchema } from "./org-settings.js";

export const CONTEXT_TREE_SNAPSHOT_STATUSES = {
  ACTIVE: "active",
  STALE: "stale",
  UNAVAILABLE: "unavailable",
} as const;

export const contextTreeSnapshotStatusSchema = z.enum(["active", "stale", "unavailable"]);
export type ContextTreeSnapshotStatus = z.infer<typeof contextTreeSnapshotStatusSchema>;

export const CONTEXT_TREE_STATUS_SEVERITIES = {
  OK: "ok",
  WARNING: "warning",
  ERROR: "error",
} as const;

export const contextTreeStatusSeveritySchema = z.enum(["ok", "warning", "error"]);
export type ContextTreeStatusSeverity = z.infer<typeof contextTreeStatusSeveritySchema>;

export const contextTreeStatusSchema = z.object({
  label: z.string(),
  detail: z.string().nullable(),
  severity: contextTreeStatusSeveritySchema,
});
export type ContextTreeStatus = z.infer<typeof contextTreeStatusSchema>;

export const CONTEXT_TREE_NODE_KINDS = {
  ROOT: "root",
  DOMAIN: "domain",
  SUBDOMAIN: "subdomain",
  LEAF: "leaf",
} as const;

export const contextTreeNodeKindSchema = z.enum(["root", "domain", "subdomain", "leaf"]);
export type ContextTreeNodeKind = z.infer<typeof contextTreeNodeKindSchema>;

export const CONTEXT_TREE_CHANGE_TYPES = {
  ADDED: "added",
  EDITED: "edited",
  REMOVED: "removed",
} as const;

export const contextTreeChangeTypeSchema = z.enum(["added", "edited", "removed"]);
export type ContextTreeChangeType = z.infer<typeof contextTreeChangeTypeSchema>;

export const CONTEXT_TREE_EDGE_KINDS = {
  PARENT: "parent",
  SOFT_LINK: "soft_link",
  MARKDOWN_LINK: "markdown_link",
} as const;

export const contextTreeEdgeKindSchema = z.enum(["parent", "soft_link", "markdown_link"]);
export type ContextTreeEdgeKind = z.infer<typeof contextTreeEdgeKindSchema>;

export const CONTEXT_TREE_RISK_LEVELS = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
} as const;

export const contextTreeRiskLevelSchema = z.enum(["low", "medium", "high"]);
export type ContextTreeRiskLevel = z.infer<typeof contextTreeRiskLevelSchema>;

export const contextTreeNodeSchema = z.object({
  id: z.string(),
  path: z.string(),
  sourcePath: z.string().nullable(),
  title: z.string(),
  kind: contextTreeNodeKindSchema,
  owners: z.array(z.string()),
  parentId: z.string().nullable(),
  preview: z.string().nullable(),
  relatedNodeIds: z.array(z.string()),
  affectedContextArea: z.string(),
  changeType: contextTreeChangeTypeSchema.nullable(),
  changedAtCommit: z.string().nullable(),
});
export type ContextTreeNode = z.infer<typeof contextTreeNodeSchema>;

export const contextTreeEdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
  kind: contextTreeEdgeKindSchema,
});
export type ContextTreeEdge = z.infer<typeof contextTreeEdgeSchema>;

export const contextTreeChangeSchema = z.object({
  path: z.string(),
  nodeId: z.string().nullable(),
  type: contextTreeChangeTypeSchema,
  commit: z.string().nullable(),
  changedAt: z.string().nullable(),
  changedBy: z.string().nullable(),
  summary: z.string().nullable(),
  // Pull-request number parsed from the commit subject (e.g. the `(#514)`
  // a squash-merge appends). Null when the landing commit carries no PR
  // reference. Defaulted so existing change constructors stay valid.
  prNumber: z.number().int().positive().nullable().default(null),
});
export type ContextTreeChange = z.infer<typeof contextTreeChangeSchema>;

export const contextTreeUpdateSchema = z.object({
  id: z.string(),
  nodeId: z.string().nullable(),
  path: z.string(),
  title: z.string(),
  changeType: contextTreeChangeTypeSchema,
  affectedContextArea: z.string(),
  reason: z.string(),
  summary: z.string(),
  changedBy: z.string().nullable(),
  owners: z.array(z.string()),
  relatedNodeIds: z.array(z.string()),
  sourceCommit: z.string().nullable(),
  riskLevel: contextTreeRiskLevelSchema,
});
export type ContextTreeUpdate = z.infer<typeof contextTreeUpdateSchema>;

export const contextTreeSummarySchema = z.object({
  addedCount: z.number().int().nonnegative(),
  editedCount: z.number().int().nonnegative(),
  removedCount: z.number().int().nonnegative(),
  changedNodeCount: z.number().int().nonnegative(),
});
export type ContextTreeSummary = z.infer<typeof contextTreeSummarySchema>;

export const contextTreeUsageEventSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  // Manager-selected avatar color token ("hue-0".."hue-7"). NULL means
  // "auto" — the web client falls back to a deterministic hash of agentId.
  // Mirrors the agents.avatar_color_token column so the feed can render
  // the same avatar disc the rest of the UI uses.
  agentAvatarColorToken: z.string().nullable(),
  // chatId and chatTitle are exposed for every event whose chat lives in
  // the same organization as the caller — Context Tab is an org-wide
  // transparency surface where members see how the tree is being used,
  // including the chat each session belongs to. Chat *content* remains
  // private (requireChatAccess still gates the chat-detail route);
  // only the topic label is shared.
  //
  // Both fields mask to null together when the chat does not belong to
  // this organization (a defensive guard against stale / forged
  // cross-org session_events.chat_id values — chatId itself is
  // identifying info, so it is masked alongside chatTitle).
  chatId: z.string().nullable(),
  chatTitle: z.string().nullable(),
  // Tree-root-relative path of the node the agent read (e.g.
  // `members/Gandy2025/NODE.md`), surfaced from the session event payload so
  // the web feed can show *which* node was consulted. Null for pre-P0 events
  // (recorded before per-read node tracking) or reads that could not be
  // resolved to a node path.
  nodePath: z.string().nullable(),
  // Whether the caller may actually open this chat — true iff they satisfy
  // the same membership rule as `requireChatAccess` (their human agent has a
  // chat_membership row, i.e. speaker OR watcher, OR they manage a speaker in
  // the chat). The feed shares chatId/chatTitle org-wide for transparency, but
  // only a viewer who can access the chat should get a clickable deep link;
  // others render it as inert text. Always false for cross-org events (where
  // chatId is masked to null) and computed fresh per request (never stored).
  viewerCanAccess: z.boolean(),
  createdAt: z.string(),
});
export type ContextTreeUsageEvent = z.infer<typeof contextTreeUsageEventSchema>;

export const contextTreeUsageSummarySchema = z.object({
  windowDays: z.number().int().positive(),
  agentCount: z.number().int().nonnegative(),
  usageCount: z.number().int().nonnegative(),
  recentEvents: z.array(contextTreeUsageEventSchema),
});
export type ContextTreeUsageSummary = z.infer<typeof contextTreeUsageSummarySchema>;

export const contextTreeIoActionSchema = z.enum(["read", "write"]);
export type ContextTreeIoAction = z.infer<typeof contextTreeIoActionSchema>;

export const contextTreeIoTargetKindSchema = z.enum(["file", "directory", "repo"]);
export type ContextTreeIoTargetKind = z.infer<typeof contextTreeIoTargetKindSchema>;

export const contextTreeIoSourceSchema = z.enum([
  "legacy_context_tree_usage",
  "claude_read_tool",
  "claude_write_tool",
  "codex_file_change",
  "shell_command",
  "git_status_delta",
]);
export type ContextTreeIoSource = z.infer<typeof contextTreeIoSourceSchema>;

export const contextTreeIoSkipReasonSchema = z.enum([
  "no_org_context_tree_binding",
  "event_kind_not_io",
  "status_not_ok",
  "unsupported_tool",
  "unsupported_shell_command",
  "no_tool_file_refs",
  "ref_schema_invalid",
  "ref_repo_mismatch",
  "ref_path_invalid",
  "chat_not_in_org",
]);
export type ContextTreeIoSkipReason = z.infer<typeof contextTreeIoSkipReasonSchema>;

export const contextTreeIoBucketSchema = z.object({
  agentCount: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  targetCount: z.number().int().nonnegative(),
});
export type ContextTreeIoBucket = z.infer<typeof contextTreeIoBucketSchema>;

export const contextTreeIoAgentSummarySchema = z.object({
  agentId: z.string(),
  agentName: z.string(),
  agentAvatarColorToken: z.string().nullable(),
  runtimeProvider: z.string(),
  readCount: z.number().int().nonnegative(),
  writeCount: z.number().int().nonnegative(),
  lastReadAt: z.string().nullable(),
  lastWriteAt: z.string().nullable(),
});
export type ContextTreeIoAgentSummary = z.infer<typeof contextTreeIoAgentSummarySchema>;

export const contextTreeIoEventSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  agentAvatarColorToken: z.string().nullable(),
  runtimeProvider: z.string(),
  action: contextTreeIoActionSchema,
  source: contextTreeIoSourceSchema,
  targetKind: contextTreeIoTargetKindSchema,
  targetPath: z.string(),
  chatId: z.string().nullable(),
  chatTitle: z.string().nullable(),
  viewerCanAccess: z.boolean(),
  createdAt: z.string(),
});
export type ContextTreeIoEvent = z.infer<typeof contextTreeIoEventSchema>;

// A tree *write*, derived from the context-tree repo's git history rather than
// live session telemetry. Git is the only source that captures every landed
// change — PR merges and worktree edits included — so writes are complete and
// attributed even when the session-telemetry path drops them. Reads stay on
// telemetry (`contextTreeIoEventSchema`) because reads produce no commits.
export const contextTreeWriteEventSchema = z.object({
  // Stable per (commit, node): `${commit}:${nodePath}`.
  id: z.string(),
  nodeId: z.string().nullable(),
  // Tree-root-relative path of the changed node (e.g.
  // `system/cloud/team/tenancy-and-identity`).
  nodePath: z.string(),
  title: z.string(),
  changeType: contextTreeChangeTypeSchema,
  summary: z.string().nullable(),
  riskLevel: contextTreeRiskLevelSchema,
  // Raw git author (`%an`) of the landing commit. Always present as the
  // fallback display name when the author can't be resolved to a known agent
  // (e.g. PR-merge commits authored by GitHub, or humans).
  authorName: z.string().nullable(),
  // Resolved org agent when `authorName` matches an agent's name / display
  // name; null otherwise (the UI then shows `authorName`). Best-effort
  // attribution — see attributeContextTreeWrites.
  agentId: z.string().nullable(),
  agentName: z.string().nullable(),
  agentAvatarColorToken: z.string().nullable(),
  commit: z.string().nullable(),
  prNumber: z.number().int().positive().nullable(),
  // Commit time (ISO). Null only when git omitted it.
  createdAt: z.string().nullable(),
});
export type ContextTreeWriteEvent = z.infer<typeof contextTreeWriteEventSchema>;

export const contextTreeIoSkipBreakdownSchema = z.object({
  reason: contextTreeIoSkipReasonSchema,
  eventCount: z.number().int().nonnegative(),
  agentCount: z.number().int().nonnegative(),
  runtimeProviders: z.array(
    z.object({
      runtimeProvider: z.string(),
      eventCount: z.number().int().nonnegative(),
    }),
  ),
  toolNames: z.array(
    z.object({
      toolName: z.string(),
      eventCount: z.number().int().nonnegative(),
    }),
  ),
});
export type ContextTreeIoSkipBreakdown = z.infer<typeof contextTreeIoSkipBreakdownSchema>;

export const contextTreeIoSkipSummarySchema = z.object({
  windowDays: z.number().int().positive(),
  totalEventCount: z.number().int().nonnegative(),
  reasons: z.array(contextTreeIoSkipBreakdownSchema),
});
export type ContextTreeIoSkipSummary = z.infer<typeof contextTreeIoSkipSummarySchema>;

export const contextTreeIoSummarySchema = z.object({
  windowDays: z.number().int().positive(),
  summary: z.object({
    read: contextTreeIoBucketSchema,
    write: contextTreeIoBucketSchema,
  }),
  agents: z.array(contextTreeIoAgentSummarySchema),
  // Telemetry-sourced READ events only (best-effort, capped). Writes used to
  // ride this array too, but the telemetry write path silently drops merges
  // and worktree edits; writes now come from `writes` (git-derived, complete).
  recentEvents: z.array(contextTreeIoEventSchema),
  // Git-derived writes for the window — complete and attributed. Capped by the
  // diff-entry limit, not the read feed's 50-cap; `writesTotal` is the count
  // before any client-side pagination.
  writes: z.array(contextTreeWriteEventSchema),
  writesTotal: z.number().int().nonnegative(),
  skipped: contextTreeIoSkipSummarySchema,
});
export type ContextTreeIoSummary = z.infer<typeof contextTreeIoSummarySchema>;

// The one structured recovery cause the Context tab can act on: the snapshot
// is unavailable specifically because the GitHub App installation can't read
// the bound repo, and adding the repo to the installation fixes it. The server
// sets this only after probing repo access, so the UI never misdirects users
// to GitHub for unavailable causes that adding a repo can't fix (bad branch,
// transient clone error, local / non-GitHub binding, missing / suspended
// installation).
export const contextTreeRecoveryActionSchema = z.literal("manage_github_app_installation");
export type ContextTreeRecoveryAction = z.infer<typeof contextTreeRecoveryActionSchema>;

export const contextTreeSnapshotSchema = z.object({
  repo: z.string().nullable(),
  branch: z.string().nullable(),
  headCommit: z.string().nullable(),
  syncedAt: z.string().nullable(),
  snapshotStatus: contextTreeSnapshotStatusSchema,
  contextStatus: contextTreeStatusSchema,
  // Absent/null for the happy path and for every unavailable cause other than
  // a probed GitHub App repo-coverage gap. See contextTreeRecoveryActionSchema.
  recoveryAction: contextTreeRecoveryActionSchema.nullish(),
  summary: contextTreeSummarySchema,
  usage: contextTreeUsageSummarySchema,
  io: contextTreeIoSummarySchema,
  updates: z.array(contextTreeUpdateSchema),
  nodes: z.array(contextTreeNodeSchema),
  edges: z.array(contextTreeEdgeSchema),
  changes: z.array(contextTreeChangeSchema),
});
export type ContextTreeSnapshot = z.infer<typeof contextTreeSnapshotSchema>;

export const initializeContextTreeRequestSchema = z.object({}).strict();
export type InitializeContextTreeRequest = z.infer<typeof initializeContextTreeRequestSchema>;

const GITHUB_REPOSITORY_HTML_URL_PREFIX = "https://github.com/";
const GITHUB_REPOSITORY_HTML_URL_RE =
  /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

const githubRepositoryHtmlUrlSchema = z.string().superRefine((value, ctx) => {
  const hasControlCharacter = Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f));
  });
  const hasWhitespace = Array.from(value).some((character) => /\s/u.test(character));
  if (value.trim() !== value || hasWhitespace || hasControlCharacter || value.includes("\\")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "GitHub repository URL contains unsafe whitespace." });
    return;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "GitHub repository URL must be a valid URL." });
    return;
  }
  const rawPath = value.startsWith(GITHUB_REPOSITORY_HTML_URL_PREFIX)
    ? value.slice(GITHUB_REPOSITORY_HTML_URL_PREFIX.length)
    : "";
  const hasDotPathSegment = rawPath.split("/").some((segment) => segment === "." || segment === "..");
  if (hasDotPathSegment || url.href !== value) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "GitHub repository URL must use a canonical path without dot segments.",
    });
    return;
  }
  if (
    url.origin !== "https://github.com" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    !GITHUB_REPOSITORY_HTML_URL_RE.test(value)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "GitHub repository URL must be a credential-free HTTPS repository URL.",
    });
  }
});

export const initializeContextTreeResponseSchema = z
  .object({
    repo: contextTreeRepoSchema,
    htmlUrl: githubRepositoryHtmlUrlSchema,
    branch: z.literal("main"),
    nodePath: z.literal("NODE.md"),
  })
  .superRefine((value, ctx) => {
    if (value.repo !== `${value.htmlUrl}.git`) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["repo"],
        message: "GitHub clone and HTML URLs must identify the same repository.",
      });
    }
  });
export type InitializeContextTreeResponse = z.infer<typeof initializeContextTreeResponseSchema>;

// Read-only view of the team's bound GitHub App installation, exposed so a
// user's local `gh` can add an agent-created tree repo to a
// selected-repositories installation (`PUT /user/installations/{id}/repositories/{repoId}`).
// The server/App cannot add a repo to its own installation, but the user who
// administers the installation can — this is the agent-driven counterpart to the
// old server-side write-permission bootstrap. Returns only non-secret routing
// facts; no token is minted or returned here.
export const contextTreeInstallationInfoResponseSchema = z.object({
  installationId: z.number().int().positive(),
  accountLogin: z.string(),
  accountType: z.enum(["User", "Organization"]),
  suspended: z.boolean(),
});
export type ContextTreeInstallationInfoResponse = z.infer<typeof contextTreeInstallationInfoResponseSchema>;
