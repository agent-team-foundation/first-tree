import { z } from "zod";

/** Runtime engines that the daemon may install from a server command. */
export const runtimeInstallProviderSchema = z.enum(["claude-code", "codex"]);
export type RuntimeInstallProvider = z.infer<typeof runtimeInstallProviderSchema>;

export const RUNTIME_INSTALL_START_TYPE = "runtime-install:start" as const;
export const RUNTIME_INSTALL_RESULT_TYPE = "runtime-install:result" as const;

/** Server -> daemon command. No caller-controlled package, version, or shell input is allowed. */
export const runtimeInstallStartCommandSchema = z
  .object({
    type: z.literal(RUNTIME_INSTALL_START_TYPE),
    provider: runtimeInstallProviderSchema,
    ref: z.string().uuid(),
  })
  .strict();
export type RuntimeInstallStartCommand = z.infer<typeof runtimeInstallStartCommandSchema>;

/** Web -> server request. The selected Computer is carried by the route parameter. */
export const runtimeInstallStartRequestSchema = z
  .object({
    provider: runtimeInstallProviderSchema,
  })
  .strict();
export type RuntimeInstallStartRequest = z.infer<typeof runtimeInstallStartRequestSchema>;

export const runtimeInstallProgressStatusSchema = z.enum(["accepted", "in-progress"]);
export type RuntimeInstallProgressStatus = z.infer<typeof runtimeInstallProgressStatusSchema>;

const runtimeInstallResultBaseSchema = z.object({
  type: z.literal(RUNTIME_INSTALL_RESULT_TYPE),
  provider: runtimeInstallProviderSchema,
  ref: z.string().uuid(),
});

/** Daemon -> server progress and terminal result frames. */
export const runtimeInstallResultFrameSchema = z.discriminatedUnion("status", [
  runtimeInstallResultBaseSchema.extend({ status: z.literal("accepted") }),
  runtimeInstallResultBaseSchema.extend({ status: z.literal("in-progress") }),
  runtimeInstallResultBaseSchema.extend({
    status: z.literal("succeeded"),
    installedVersion: z.string().max(64).nullable(),
  }),
  runtimeInstallResultBaseSchema.extend({
    status: z.literal("failed"),
    reason: z.string().min(1).max(500),
    reasonCode: z.string().min(1).max(100),
    retryable: z.boolean(),
  }),
]);
export type RuntimeInstallResultFrame = z.infer<typeof runtimeInstallResultFrameSchema>;

export const runtimeInstallTerminalResultFrameSchema = z.discriminatedUnion("status", [
  runtimeInstallResultBaseSchema.extend({
    status: z.literal("succeeded"),
    installedVersion: z.string().max(64).nullable(),
  }),
  runtimeInstallResultBaseSchema.extend({
    status: z.literal("failed"),
    reason: z.string().min(1).max(500),
    reasonCode: z.string().min(1).max(100),
    retryable: z.boolean(),
  }),
]);
export type RuntimeInstallTerminalResultFrame = z.infer<typeof runtimeInstallTerminalResultFrameSchema>;

/** Terminal HTTP response. `progress` proves the daemon accepted and started the controlled install. */
export const runtimeInstallStartResponseSchema = z.discriminatedUnion("status", [
  runtimeInstallTerminalResultFrameSchema.options[0].omit({ type: true }).extend({
    progress: z.array(runtimeInstallProgressStatusSchema).max(2),
  }),
  runtimeInstallTerminalResultFrameSchema.options[1].omit({ type: true }).extend({
    progress: z.array(runtimeInstallProgressStatusSchema).max(2),
  }),
]);
export type RuntimeInstallStartResponse = z.infer<typeof runtimeInstallStartResponseSchema>;
