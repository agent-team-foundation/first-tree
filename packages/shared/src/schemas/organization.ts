import { z } from "zod";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const createOrganizationSchema = z.object({
  /** URL-friendly slug (e.g. "acme-corp"). Must be lowercase alphanumeric with hyphens. */
  name: z
    .string()
    .min(2)
    .max(50)
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      "Must start with a letter or digit and contain only lowercase alphanumeric and hyphens",
    )
    .refine((v) => !UUID_PATTERN.test(v), "Name must not be a UUID format"),
  displayName: z.string().min(1).max(200),
  /** 0 = unlimited (self-hosted default) */
  maxAgents: z.number().int().min(0).default(0),
  /** 0 = unlimited */
  maxMessagesPerMinute: z.number().int().min(0).default(0),
  features: z.record(z.string(), z.unknown()).default({}),
});
export type CreateOrganization = z.infer<typeof createOrganizationSchema>;
/** Input type (before Zod defaults are applied) — use in service function signatures. */
export type CreateOrganizationInput = z.input<typeof createOrganizationSchema>;

export const updateOrganizationSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(50)
    .regex(
      /^[a-z0-9][a-z0-9-]*$/,
      "Must start with a letter or digit and contain only lowercase alphanumeric and hyphens",
    )
    .refine((v) => !UUID_PATTERN.test(v), "Name must not be a UUID format")
    .optional(),
  displayName: z.string().min(1).max(200).optional(),
  maxAgents: z.number().int().min(0).optional(),
  maxMessagesPerMinute: z.number().int().min(0).optional(),
  features: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateOrganization = z.infer<typeof updateOrganizationSchema>;

export const organizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  maxAgents: z.number(),
  maxMessagesPerMinute: z.number(),
  features: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Organization = z.infer<typeof organizationSchema>;
