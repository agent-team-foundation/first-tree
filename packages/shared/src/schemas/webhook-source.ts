import { z } from "zod";

/**
 * Origin of a normalized webhook event. After the GitHub App ingestion
 * cutover this is single-form (App installations only); the type stays
 * a structured object so future non-GitHub sources can be added by
 * widening it into a discriminated union without churning callers.
 */
export const webhookSourceSchema = z.object({
  kind: z.literal("github-app-installation"),
  installationId: z.number().int(),
  organizationId: z.string().min(1),
});
export type WebhookSource = z.infer<typeof webhookSourceSchema>;
