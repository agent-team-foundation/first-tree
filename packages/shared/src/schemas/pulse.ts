import { z } from "zod";

export const pulseBucketSchema = z.object({
  workingCount: z.number().int().nonnegative(),
  errorMask: z.boolean(),
});

export type PulseBucket = z.infer<typeof pulseBucketSchema>;

export const pulseTickSchema = z.object({
  type: z.literal("pulse:tick"),
  organizationId: z.string(),
  agents: z.record(z.string(), z.array(pulseBucketSchema).length(32)),
});

export type PulseTick = z.infer<typeof pulseTickSchema>;
