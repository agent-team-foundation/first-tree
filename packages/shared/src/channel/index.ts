import { homedir } from "node:os";
import { join } from "node:path";
import { getConfig } from "../config/singleton.js";

export const DEFAULT_PORTABLE_DOWNLOAD_BASE_URL = "https://downloads.first-tree.ai";

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
  /**
   * Human-readable name surfaced to the OS service manager. macOS lists
   * background items by the launched program's filename, so the launchd
   * wrapper script is named after this (see `renderLaunchdWrapper` in the
   * CLI). Keep each channel distinct so parallel installs are
   * distinguishable in System Settings → Login Items & Extensions.
   */
  displayName: string;
  portable: {
    /** Path segment under the portable download base URL. `null` for dev. */
    channelPrefix: string | null;
    /** Public installer path under the channel prefix. `null` for dev. */
    publicInstallerPath: string | null;
    /** Default immutable-manifest / installer base URL. `null` for dev. */
    downloadBaseUrl: string | null;
  };
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
    displayName: "First Tree (Dev)",
    portable: {
      channelPrefix: null,
      publicInstallerPath: null,
      downloadBaseUrl: null,
    },
  },
  staging: {
    binName: "first-tree-staging",
    aliasName: "fts",
    packageName: "first-tree-staging",
    homeDirName: ".first-tree-staging",
    defaultServerUrl: "https://dev.cloud.first-tree.ai",
    serviceUnitName: "first-tree-staging",
    launchdLabel: "first-tree-staging",
    displayName: "First Tree (Staging)",
    portable: {
      channelPrefix: "staging",
      publicInstallerPath: "staging/install.sh",
      downloadBaseUrl: DEFAULT_PORTABLE_DOWNLOAD_BASE_URL,
    },
  },
  prod: {
    binName: "first-tree",
    aliasName: "ft",
    packageName: "first-tree",
    homeDirName: ".first-tree",
    defaultServerUrl: "https://cloud.first-tree.ai",
    serviceUnitName: "first-tree",
    launchdLabel: "first-tree",
    displayName: "First Tree",
    portable: {
      channelPrefix: "prod",
      publicInstallerPath: "prod/install.sh",
      downloadBaseUrl: DEFAULT_PORTABLE_DOWNLOAD_BASE_URL,
    },
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
  displayName: string;
  portable: {
    channelPrefix: string | null;
    publicInstallerPath: string | null;
    downloadBaseUrl: string | null;
  };
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
    displayName: def.displayName,
    portable: def.portable,
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

/**
 * Channel-resolved CLI identity for the current server process. Reads the
 * channel from the config singleton (set by `initConfig()` at boot) and
 * threads it through {@link getChannelConfig}. Process-level constant —
 * channel never changes after init.
 *
 * Single helper so every server-side error message / bootstrap-hint /
 * dashboard string emits the same channel-correct CLI name without each
 * caller hand-rolling `getChannelConfig(getConfig().channel)`. Throws when
 * called before `initConfig()` (fail-loud — silent fallback to the default
 * channel would reintroduce the multi-env footgun where staging servers
 * tell clients to install the prod tarball).
 *
 * Client / CLI code paths must NOT use this — their channel comes from
 * `apps/cli/src/build-info.ts` at build time and is installed into
 * `@first-tree/client` via `setCliBinding` (`packages/client/src/runtime/
 * cli-binding.ts`). The two surfaces stay symmetric: server reads its own
 * config; client receives an entrypoint-supplied binding.
 */
export function getServerCliBinding(): ChannelConfig {
  const config = getConfig<{ channel: ChannelName }>();
  return getChannelConfig(config.channel);
}
