import { z } from "zod";

export const PORTABLE_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const;
export const portablePlatformSchema = z.enum(PORTABLE_PLATFORMS);
export type PortablePlatform = z.infer<typeof portablePlatformSchema>;

export const portableChannelSchema = z.enum(["staging", "prod"]);
export type PortableChannel = z.infer<typeof portableChannelSchema>;

export const portableInstallMethodSchema = z.enum(["npm", "portable", "source"]);
export type PortableInstallMethod = z.infer<typeof portableInstallMethodSchema>;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const portableAssetSchema = z.object({
  platform: portablePlatformSchema,
  fileName: z.string().min(1),
  url: z.string().url(),
  sha256: sha256Schema,
  size: z.number().int().nonnegative(),
});
export type PortableAsset = z.infer<typeof portableAssetSchema>;

const portableMetadataBaseSchema = z.object({
  schemaVersion: z.literal(1),
  channel: portableChannelSchema,
  version: z.string().min(1),
  gitSha: z.string().min(1),
  nodeVersion: z.string().min(1),
  packageName: z.string().min(1),
  binName: z.string().min(1),
  aliasName: z.string().min(1),
  generatedAt: z.string().datetime({ offset: true }),
});

export const portableManifestSchema = portableMetadataBaseSchema.extend({
  assets: z.array(portableAssetSchema).min(1),
});
export type PortableManifest = z.infer<typeof portableManifestSchema>;

export const portableLatestSchema = portableMetadataBaseSchema.extend({
  manifestUrl: z.string().url(),
  assets: z.array(portableAssetSchema).min(1),
});
export type PortableLatest = z.infer<typeof portableLatestSchema>;

export const portableInstallMetadataSchema = portableMetadataBaseSchema.extend({
  platform: portablePlatformSchema,
  installMode: z.literal("portable"),
  appEntry: z.literal("app/cli/index.mjs"),
});
export type PortableInstallMetadata = z.infer<typeof portableInstallMetadataSchema>;
