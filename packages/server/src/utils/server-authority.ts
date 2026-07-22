import { deriveAvatarAuthorityTag, resolveServerAuthority } from "@first-tree/shared/config";
import type { Config } from "../config.js";

export function configuredServerAuthority(config: Config): string {
  return resolveServerAuthority(config.server);
}

export function configuredAvatarAuthorityTag(config: Config): string {
  return deriveAvatarAuthorityTag(configuredServerAuthority(config));
}
