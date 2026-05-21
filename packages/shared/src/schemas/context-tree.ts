import { z } from "zod";

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

export const contextTreeSnapshotSchema = z.object({
  repo: z.string().nullable(),
  branch: z.string().nullable(),
  headCommit: z.string().nullable(),
  syncedAt: z.string().nullable(),
  snapshotStatus: contextTreeSnapshotStatusSchema,
  contextStatus: contextTreeStatusSchema,
  summary: contextTreeSummarySchema,
  usage: contextTreeUsageSummarySchema,
  updates: z.array(contextTreeUpdateSchema),
  nodes: z.array(contextTreeNodeSchema),
  edges: z.array(contextTreeEdgeSchema),
  changes: z.array(contextTreeChangeSchema),
});
export type ContextTreeSnapshot = z.infer<typeof contextTreeSnapshotSchema>;
