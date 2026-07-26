import { z } from "zod";
import { involveReasonSchema } from "./normalized-event.js";

export const scmAttentionProvenanceSchema = z.enum(["explicit", "identity_target", "related_entity"]);
export type ScmAttentionProvenance = z.infer<typeof scmAttentionProvenanceSchema>;

export const scmAttentionLineSchema = z.object({
  kind: z.literal("attention_line"),
  humanAgentId: z.string().min(1),
  wakeAgentId: z.string().min(1),
  chatId: z.string().min(1),
  provenance: scmAttentionProvenanceSchema,
});
export type ScmAttentionLine = z.infer<typeof scmAttentionLineSchema>;

export const scmLegacyRouteSchema = z.object({
  kind: z.literal("legacy_route_only"),
  chatId: z.string().min(1),
  senderAgentId: z.string().min(1),
  wakeAgentId: z.null(),
  provenance: z.literal("legacy_explicit"),
});
export type ScmLegacyRoute = z.infer<typeof scmLegacyRouteSchema>;

export const scmAudienceEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("existing_line"),
    line: scmAttentionLineSchema,
  }),
  z.object({
    kind: z.literal("legacy_route"),
    route: scmLegacyRouteSchema,
  }),
  z.object({
    kind: z.literal("personnel_target"),
    reason: involveReasonSchema,
    humanAgentId: z.string().min(1),
    wakeAgentId: z.string().min(1),
    externalUsername: z.string().min(1),
  }),
]);
export type ScmAudienceEntry = z.infer<typeof scmAudienceEntrySchema>;
