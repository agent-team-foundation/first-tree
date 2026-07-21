import { z } from "zod";

export const CONTEXT_REVIEW_TASK_TYPE = "context_tree_pr_review" as const;
export const CONTEXT_REVIEW_MANAGED_MARKER = "<!-- first-tree-context-review:managed-v1 -->" as const;
export const CONTEXT_REVIEW_PACKET_MAX_BYTES = 32 * 1024;
export const CONTEXT_REVIEW_TASK_METADATA_MAX_DEPTH = 64;
const CONTEXT_REVIEW_TASK_METADATA_MAX_NODES = 8 * 1024;

export const contextReviewManagedEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventType: z.enum(["pull_request", "issue_comment", "pull_request_review_comment"]),
    action: z.enum([
      "opened",
      "synchronize",
      "ready_for_review",
      "reopened",
      "closed",
      "review_requested",
      "assigned",
      "edited",
      "created",
    ]),
    triggerEvent: z.string().trim().min(1),
    repository: z
      .string()
      .trim()
      .regex(/^[^\s/]+\/[^\s/]+$/),
    pullRequest: z.number().int().positive(),
    senderLogin: z.string().trim().min(1),
    deliveryId: z.string().trim().min(1).optional(),
    headSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
    isDraft: z.boolean().optional(),
    terminalState: z.enum(["closed", "merged"]).optional(),
    commentId: z
      .string()
      .regex(/^[1-9]\d*$/)
      .optional(),
    commentAuthorLogin: z.string().trim().min(1).optional(),
    commentUrl: z.string().url().optional(),
  })
  .strict();
export type ContextReviewManagedEvent = z.infer<typeof contextReviewManagedEventSchema>;

/**
 * Live GitHub lifecycle observed while the keyed Review Chat is locked.
 * This intentionally rides beside (rather than inside) the strict V1 event
 * envelope so an older Server can ignore the new authority record during a
 * server-first rollout instead of rejecting the whole message metadata.
 */
export const contextReviewManagedLifecycleSchema = z
  .object({
    schemaVersion: z.literal(1),
    state: z.enum(["open", "closed", "merged"]),
  })
  .strict();
export type ContextReviewManagedLifecycle = z.infer<typeof contextReviewManagedLifecycleSchema>;

/**
 * Server-authored metadata for managed Context Review webhook messages. The
 * message service reserves both `systemSender` and `contextReview*` keys, so
 * clients may use this complete envelope as a synthetic-sender trust signal.
 */
export const contextReviewManagedMessageMetadataSchema = z
  .object({
    source: z.literal("github"),
    systemSender: z.literal("github"),
    contextReviewManagedEventV1: contextReviewManagedEventSchema,
    contextReviewManagedLifecycleV1: contextReviewManagedLifecycleSchema.optional(),
  })
  .passthrough();
export type ContextReviewManagedMessageMetadata = z.infer<typeof contextReviewManagedMessageMetadataSchema>;

const githubRepositorySchema = z
  .string()
  .trim()
  .regex(/^[^\s/]+\/[^\s/]+$/, "repository must use owner/name form");
const gitRefSchema = z.string().trim().min(1).max(1024);
const commitOidSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/i, "expectedHead must be a full 40-character commit OID")
  .transform((value) => value.toLowerCase());
const repositoryPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
    "path must be a normalized repository-relative path",
  );

const contextReviewEvidenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("reference"),
      label: z.string().trim().min(1),
      reference: z.string().trim().min(1),
      revision: z.string().trim().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("excerpt"),
      label: z.string().trim().min(1),
      provenance: z.string().trim().min(1),
      text: z.string().trim().min(1),
    })
    .strict(),
]);

/**
 * Versioned evidence delivered with a managed Context Review task. GitHub and
 * the live Context Tree binding remain authoritative; this packet supplies
 * discovery context and the PR author's declared repair scope.
 */
export const reviewPacketV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    repository: githubRepositorySchema,
    pullRequest: z.number().int().positive(),
    expectedHead: commitOidSchema,
    baseRef: gitRefSchema,
    sourceRef: gitRefSchema,
    requesterGithubLogin: z.string().trim().min(1).max(255),
    goal: z.string().trim().min(1),
    source: z
      .object({
        label: z.string().trim().min(1),
        reference: z.string().trim().min(1),
        revision: z.string().trim().min(1).optional(),
      })
      .strict(),
    decisionSummary: z.string().trim().min(1),
    rationale: z.string().trim().min(1),
    targetPaths: z.array(repositoryPathSchema).default([]),
    repairScope: z.array(repositoryPathSchema).min(1),
    relevantContextRefs: z.array(z.string().trim().min(1)).default([]),
    unresolvedQuestions: z.array(z.string().trim().min(1)).default([]),
    verify: z
      .object({
        status: z.enum(["passed", "failed", "not_run"]),
        summary: z.string().trim().min(1),
      })
      .strict(),
    evidence: z.array(contextReviewEvidenceSchema).default([]),
  })
  .strict();
export type ReviewPacketV1 = z.infer<typeof reviewPacketV1Schema>;

type TaskMetadataInspection = {
  serializedBytes: number;
  exceedsMaxDepth: boolean;
  exceedsMaxNodes: boolean;
};

function inspectTaskMetadata(value: unknown): TaskMetadataInspection {
  const encoder = new TextEncoder();
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodeCount = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    nodeCount += 1;
    if (nodeCount > CONTEXT_REVIEW_TASK_METADATA_MAX_NODES) {
      return { serializedBytes: 0, exceedsMaxDepth: false, exceedsMaxNodes: true };
    }
    if (current.depth > CONTEXT_REVIEW_TASK_METADATA_MAX_DEPTH) {
      return { serializedBytes: 0, exceedsMaxDepth: true, exceedsMaxNodes: false };
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
      continue;
    }
    if (typeof current.value !== "object" || current.value === null) continue;
    for (const item of Object.values(current.value)) {
      pending.push({ value: item, depth: current.depth + 1 });
    }
  }

  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("task metadata is not JSON-serializable");
  return {
    serializedBytes: encoder.encode(serialized).byteLength,
    exceedsMaxDepth: false,
    exceedsMaxNodes: false,
  };
}

const contextReviewTaskMetadataShape = z
  .object({
    taskType: z.literal(CONTEXT_REVIEW_TASK_TYPE),
    reviewPacketV1: reviewPacketV1Schema,
  })
  .strict();

function inspectTaskMetadataRefinement(value: unknown, ctx: z.RefinementCtx): void {
  let inspection: TaskMetadataInspection;
  try {
    inspection = inspectTaskMetadata(value);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Context Review task metadata could not be safely inspected",
    });
    return;
  }
  if (inspection.exceedsMaxDepth) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Context Review task metadata must not exceed ${CONTEXT_REVIEW_TASK_METADATA_MAX_DEPTH} levels`,
    });
    return;
  }
  if (inspection.exceedsMaxNodes) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Context Review task metadata is too structurally complex",
    });
    return;
  }
  if (inspection.serializedBytes > CONTEXT_REVIEW_PACKET_MAX_BYTES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Context Review task metadata must not exceed ${CONTEXT_REVIEW_PACKET_MAX_BYTES} serialized UTF-8 bytes`,
    });
  }
}

/** Generic task metadata consumed by the Reviewer runtime. */
export const contextReviewTaskMetadataSchema = z
  .unknown()
  .superRefine(inspectTaskMetadataRefinement)
  .pipe(contextReviewTaskMetadataShape)
  .superRefine(inspectTaskMetadataRefinement);
export type ContextReviewTaskMetadata = z.infer<typeof contextReviewTaskMetadataSchema>;

function isSortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);
}

/**
 * Stricter producer admission for a Write-created Agent Review task. The
 * Phase 2 consumer intentionally accepts failed/not-run verification packets;
 * dispatch only accepts a verified, deterministic file set.
 */
export const contextReviewTaskCreateMetadataSchema = contextReviewTaskMetadataSchema.superRefine((value, ctx) => {
  const packet = value.reviewPacketV1;
  if (packet.verify.status !== "passed") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reviewPacketV1", "verify", "status"],
      message: "Agent Review dispatch requires Context Tree verification to pass",
    });
  }
  if (packet.targetPaths.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reviewPacketV1", "targetPaths"],
      message: "Agent Review dispatch requires at least one target path",
    });
  }
  if (!isSortedUnique(packet.targetPaths)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reviewPacketV1", "targetPaths"],
      message: "Agent Review target paths must be sorted and unique",
    });
  }
  if (!isSortedUnique(packet.repairScope)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reviewPacketV1", "repairScope"],
      message: "Agent Review repair scope must be sorted and unique",
    });
  }
  const repairScope = new Set(packet.repairScope);
  if (packet.targetPaths.some((path) => !repairScope.has(path))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reviewPacketV1", "targetPaths"],
      message: "Agent Review target paths must be contained in repair scope",
    });
  }
});
export type ContextReviewTaskCreateMetadata = z.infer<typeof contextReviewTaskCreateMetadataSchema>;

export const CONTEXT_REVIEW_EVENTS = ["APPROVE", "REQUEST_CHANGES", "COMMENT"] as const;
export const CONTEXT_REVIEW_BODY_MAX_BYTES = 64 * 1024;

export const contextReviewEventSchema = z.enum(CONTEXT_REVIEW_EVENTS);
export type ContextReviewEvent = z.infer<typeof contextReviewEventSchema>;

export const contextReviewSubmitRequestSchema = z.object({
  reviewedHead: z
    .string()
    .regex(/^[0-9a-f]{40}$/i, "reviewedHead must be a full 40-character commit OID")
    .transform((value) => value.toLowerCase()),
  event: contextReviewEventSchema,
  body: z
    .string()
    .refine((value) => value.trim().length > 0, "body must not be empty")
    .refine((value) => new TextEncoder().encode(value).byteLength <= CONTEXT_REVIEW_BODY_MAX_BYTES, {
      message: `body must not exceed ${CONTEXT_REVIEW_BODY_MAX_BYTES} bytes`,
    }),
});
export type ContextReviewSubmitRequest = z.infer<typeof contextReviewSubmitRequestSchema>;

export const contextReviewSubmitResponseSchema = z.object({
  action: contextReviewEventSchema,
  reviewedHead: z.string().regex(/^[0-9a-f]{40}$/i),
  reviewId: z.number().int().positive(),
  reviewUrl: z.string().url(),
  appActor: z.string().min(1),
});
export type ContextReviewSubmitResponse = z.infer<typeof contextReviewSubmitResponseSchema>;

export const CONTEXT_REVIEW_ERROR_CODES = [
  "CONTEXT_REVIEW_INVALID_REQUEST",
  "CONTEXT_REVIEW_RUNTIME_SESSION_REQUIRED",
  "CONTEXT_REVIEW_RUN_NOT_FOUND",
  "CONTEXT_REVIEW_RUN_FORBIDDEN",
  "CONTEXT_REVIEW_RUN_ALREADY_SUBMITTED",
  "CONTEXT_REVIEW_RUN_PAYLOAD_MISMATCH",
  "CONTEXT_REVIEW_STALE_HEAD",
  "CONTEXT_REVIEW_PR_NOT_REVIEWABLE",
  "CONTEXT_REVIEW_APP_NOT_INSTALLED",
  "CONTEXT_REVIEW_APP_PERMISSION_REQUIRED",
  "CONTEXT_REVIEW_REPO_NOT_ACCESSIBLE",
  "CONTEXT_REVIEW_GITHUB_REJECTED",
  "CONTEXT_REVIEW_GITHUB_UNKNOWN",
] as const;
export const contextReviewErrorCodeSchema = z.enum(CONTEXT_REVIEW_ERROR_CODES);
export type ContextReviewErrorCode = z.infer<typeof contextReviewErrorCodeSchema>;
