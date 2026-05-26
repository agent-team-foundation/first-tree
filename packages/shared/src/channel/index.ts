import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Release channel identity. Single source of truth for which environment
 * a binary / server belongs to. CLI side: written to `apps/cli/src/build-info.ts`
 * at build time (CI rewrites for prod / staging publishes; source-tree value
 * is `"dev"`). Server side: read from `FIRST_TREE_CHANNEL` env var at boot.
 *
 * Every derived identifier (npm package name, bin name, default home, default
 * server URL, service unit / launchd label) is computed from this single
 * value — see `getChannelConfig` below.
 */
export type ChannelName = "dev" | "staging" | "prod";

type ChannelDef = {
  binName: string;
  aliasName: string;
  /** npm package name. `null` for dev — dev binaries are not published. */
  packageName: string | null;
  /** Home dir basename under `$HOME`. */
  homeDirName: string;
  defaultServerUrl: string;
  /** Bare service identifier — `.service` / `.plist` suffix added by callers. */
  serviceUnitName: string;
  launchdLabel: string;
};

const TABLE = {
  dev: {
    binName: "first-tree-dev",
    aliasName: "ftd",
    packageName: null,
    homeDirName: ".first-tree-dev",
    defaultServerUrl: "http://127.0.0.1:8000",
    serviceUnitName: "first-tree-dev",
    launchdLabel: "first-tree-dev",
  },
  staging: {
    binName: "first-tree-staging",
    aliasName: "fts",
    packageName: "first-tree-staging",
    homeDirName: ".first-tree-staging",
    defaultServerUrl: "https://dev.cloud.first-tree.ai",
    serviceUnitName: "first-tree-staging",
    launchdLabel: "first-tree-staging",
  },
  prod: {
    binName: "first-tree",
    aliasName: "ft",
    packageName: "first-tree",
    homeDirName: ".first-tree",
    defaultServerUrl: "https://cloud.first-tree.ai",
    serviceUnitName: "first-tree",
    launchdLabel: "first-tree",
  },
} as const satisfies Record<ChannelName, ChannelDef>;

export type ChannelConfig = {
  channel: ChannelName;
  binName: string;
  aliasName: string;
  packageName: string | null;
  defaultHome: string;
  defaultServerUrl: string;
  serviceUnitFile: string;
  launchdLabel: string;
  launchdPlistFile: string;
};

export function getChannelConfig(channel: ChannelName): ChannelConfig {
  const def = TABLE[channel];
  return {
    channel,
    binName: def.binName,
    aliasName: def.aliasName,
    packageName: def.packageName,
    defaultHome: join(homedir(), def.homeDirName),
    defaultServerUrl: def.defaultServerUrl,
    serviceUnitFile: `${def.serviceUnitName}.service`,
    launchdLabel: def.launchdLabel,
    launchdPlistFile: `${def.launchdLabel}.plist`,
  };
}

/**
 * Infer the channel a target version string belongs to. Used by the CLI's
 * self-update channel-mismatch guard — if the server pushes a target version
 * whose channel does not match the CLI's own channel, the install is refused.
 *
 * Rules (fail-closed on unknown predicates):
 *   - "0.5.1"             → "prod"     (plain stable semver)
 *   - "0.5.2-staging.X.Y" → "staging"
 *   - anything else       → "unknown"  (caller refuses to install)
 *
 * Unknown predicates include `-beta.N`, `-rc.N`, `-alpha.N` (legacy alpha
 * channel, gone post-multi-env), or anything that doesn't match the two
 * accepted shapes. Adding a new prerelease tier requires explicitly
 * extending this function.
 */
export function inferChannelFromVersion(version: string): ChannelName | "unknown" {
  if (/-staging\./.test(version)) return "staging";
  if (/^\d+\.\d+\.\d+$/.test(version)) return "prod";
  return "unknown";
}
