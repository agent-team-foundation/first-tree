import { z } from "zod";

export const CONTEXT_TREE_VERIFICATION_STATUSES = {
  VERIFIED: "verified",
  UNVERIFIED: "unverified",
  UNKNOWN: "unknown",
} as const;

export const contextTreeVerificationStatusSchema = z.enum(["verified", "unverified", "unknown"]);
export type ContextTreeVerificationStatus = z.infer<typeof contextTreeVerificationStatusSchema>;

export const TREE_WRITE_RESULT_KINDS = {
  DONE: "done",
  NO_WRITE: "no_write",
  FAILED: "failed",
} as const;

export const treeWriteResultKindSchema = z.enum(["done", "no_write", "failed"]);
export type TreeWriteTaskResultKind = z.infer<typeof treeWriteResultKindSchema>;

export const TREE_WRITE_NO_WRITE_REASON_CODES = {
  NO_DURABLE_DECISION: "no_durable_decision",
  UNVERIFIED_TREE: "unverified_tree",
  INSUFFICIENT_CONTEXT: "insufficient_context",
  AGENT_OFFLINE: "agent_offline",
} as const;

export const treeWriteNoWriteReasonCodeSchema = z.enum([
  "no_durable_decision",
  "unverified_tree",
  "insufficient_context",
  "agent_offline",
]);
export type TreeWriteNoWriteReasonCode = z.infer<typeof treeWriteNoWriteReasonCodeSchema>;

export const TREE_WRITE_ERROR_CODES = {
  TREE_WRITE_TOOL_ERROR: "tree_write_tool_error",
  INVALID_RESULT_PAYLOAD: "invalid_result_payload",
} as const;

export const treeWriteErrorCodeSchema = z.enum(["tree_write_tool_error", "invalid_result_payload"]);
export type TreeWriteErrorCode = z.infer<typeof treeWriteErrorCodeSchema>;

export const treeWriteNoWriteReasonSchema = z.object({
  code: treeWriteNoWriteReasonCodeSchema,
  message: z.string().min(1),
});
export type TreeWriteNoWriteReason = z.infer<typeof treeWriteNoWriteReasonSchema>;

export const treeWriteErrorSchema = z.object({
  code: treeWriteErrorCodeSchema,
  message: z.string().min(1),
});
export type TreeWriteError = z.infer<typeof treeWriteErrorSchema>;

export const treeWriteTaskStartSchema = z.object({
  type: z.literal("task:tree_write:start"),
  taskId: z.string(),
  execChatId: z.string(),
  sourceChatId: z.string(),
  prompt: z.string().min(1),
});
export type TreeWriteTaskStart = z.infer<typeof treeWriteTaskStartSchema>;

export const treeWriteTaskResultDoneSchema = z.object({
  type: z.literal("task:tree_write:result"),
  taskId: z.string(),
  kind: z.literal("done"),
  prUrl: z.string().url(),
});

export const treeWriteTaskResultNoWriteSchema = z.object({
  type: z.literal("task:tree_write:result"),
  taskId: z.string(),
  kind: z.literal("no_write"),
  reason: treeWriteNoWriteReasonSchema,
});

export const treeWriteTaskResultFailedSchema = z.object({
  type: z.literal("task:tree_write:result"),
  taskId: z.string(),
  kind: z.literal("failed"),
  error: treeWriteErrorSchema,
});

export const treeWriteTaskResultSchema = z.discriminatedUnion("kind", [
  treeWriteTaskResultDoneSchema,
  treeWriteTaskResultNoWriteSchema,
  treeWriteTaskResultFailedSchema,
]);
export type TreeWriteTaskResult = z.infer<typeof treeWriteTaskResultSchema>;
