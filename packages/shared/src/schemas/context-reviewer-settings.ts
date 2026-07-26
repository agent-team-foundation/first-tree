import { z } from "zod";
import { agentVisibilitySchema } from "./agent.js";
import { setupBlockerSchema, setupCapabilityHealthSchema } from "./setup-capabilities.js";

export const contextReviewerAssignmentInputSchema = z
  .object({
    agentUuid: z.string().min(1).nullable(),
  })
  .strict();

export const contextReviewerEnablementInputSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

export const contextReviewerCandidateRuntimeSchema = z
  .object({
    health: setupCapabilityHealthSchema,
    blockers: z.array(setupBlockerSchema),
  })
  .strict();

export const contextReviewerCandidateSchema = z
  .object({
    uuid: z.string().min(1),
    name: z.string().nullable(),
    displayName: z.string().min(1),
    visibility: agentVisibilitySchema,
    runtime: contextReviewerCandidateRuntimeSchema,
  })
  .strict();

export const contextReviewerCandidatesOutputSchema = z
  .object({
    items: z.array(contextReviewerCandidateSchema),
    blockers: z.array(setupBlockerSchema),
  })
  .strict();

export type ContextReviewerAssignmentInput = z.infer<typeof contextReviewerAssignmentInputSchema>;
export type ContextReviewerEnablementInput = z.infer<typeof contextReviewerEnablementInputSchema>;
export type ContextReviewerCandidateRuntime = z.infer<typeof contextReviewerCandidateRuntimeSchema>;
export type ContextReviewerCandidate = z.infer<typeof contextReviewerCandidateSchema>;
export type ContextReviewerCandidatesOutput = z.infer<typeof contextReviewerCandidatesOutputSchema>;
