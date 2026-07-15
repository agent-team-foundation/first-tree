import { z } from "zod";

export const SCM_PROVIDERS = ["github", "gitlab"] as const;
export const scmProviderSchema = z.enum(SCM_PROVIDERS);
export type ScmProvider = z.infer<typeof scmProviderSchema>;

/**
 * Authority established by the ingress adapter. This value is derived from
 * the verified endpoint/credential and must never be copied from webhook
 * headers or payload fields.
 */
export const SCM_INGRESS_AUTHORITIES = ["verified_signature", "url_bearer"] as const;
export const scmIngressAuthoritySchema = z.enum(SCM_INGRESS_AUTHORITIES);
export type ScmIngressAuthority = z.infer<typeof scmIngressAuthoritySchema>;

/**
 * Provider-neutral identity of the ingress source. `externalId` is opaque to
 * the shared processing kernel; provider adapters and their own stores decide
 * what it represents (for example, a GitHub App installation).
 */
export const scmSourceSchema = z.object({
  organizationId: z.string().min(1),
  externalId: z.string().min(1),
});
export type ScmSource = z.infer<typeof scmSourceSchema>;

export const scmIngressContextSchema = z.object({
  provider: scmProviderSchema,
  source: scmSourceSchema,
  stableDeliveryId: z.string().min(1).nullable(),
  ingressAuthority: scmIngressAuthoritySchema,
});
export type ScmIngressContext = z.infer<typeof scmIngressContextSchema>;
