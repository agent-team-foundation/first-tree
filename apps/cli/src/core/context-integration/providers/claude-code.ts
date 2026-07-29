import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import semver from "semver";
import type {
  ContextIntegrationProviderDriver,
  ProviderCommandRunner,
  ProviderHookInspectRequest,
  ProviderHookProbe,
  ProviderPluginProbe,
} from "../provider-driver.js";
import { parseProviderVersion, pluginIdentity } from "../provider-driver.js";
import { containsPlugin, defaultProviderCommandRunner, safeProviderProbe } from "./shared.js";

export class ClaudeCodeContextIntegrationDriver implements ContextIntegrationProviderDriver {
  readonly provider = "claude-code" as const;
  readonly executable: string;
  readonly minimumVersion: string;

  constructor(
    private readonly run: ProviderCommandRunner = defaultProviderCommandRunner,
    options: { executable?: string; minimumVersion?: string } = {},
  ) {
    this.executable = options.executable ?? "claude";
    this.minimumVersion = options.minimumVersion ?? "2.1.121";
  }

  probe(marketplaceName: string, pluginName: string): ProviderPluginProbe {
    const versionResult = safeProviderProbe(() => this.run(this.executable, ["--version"]));
    const version = versionResult ? parseProviderVersion(versionResult.stdout) : null;
    const list = safeProviderProbe(() => JSON.parse(this.run(this.executable, ["plugin", "list", "--json"]).stdout));
    const detectedPlugin = list
      ? containsPlugin(list, pluginName, marketplaceName)
      : { installed: false, enabled: false, installedPath: null, installedVersion: null };
    const plugin = {
      installed: detectedPlugin.installed,
      enabled: detectedPlugin.enabled,
      installedPath:
        detectedPlugin.installedPath ??
        resolveClaudeInstalledPluginPath(marketplaceName, pluginName, detectedPlugin.installedVersion),
    };
    const issues: string[] = [];
    if (!versionResult) issues.push("Claude Code executable was not found.");
    if (version && semver.lt(version, this.minimumVersion)) {
      issues.push(`Claude Code ${version} is older than the required ${this.minimumVersion}.`);
    }
    if (versionResult && !list) issues.push("Claude Code Plugin state could not be inspected.");
    return {
      provider: this.provider,
      binaryAvailable: versionResult !== null,
      version,
      compatible: version !== null && semver.gte(version, this.minimumVersion),
      ...plugin,
      issues,
    };
  }

  async inspectHook(request: ProviderHookInspectRequest): Promise<ProviderHookProbe> {
    if (!request.plugin.installed) {
      return {
        trust: "unknown",
        enabled: null,
        source: "unavailable",
        issues: [],
      };
    }
    return {
      trust: "provider_managed",
      enabled: request.plugin.enabled,
      source: "provider_managed",
      issues: [],
    };
  }

  validateMarketplace(marketplaceRoot: string): void {
    this.run(this.executable, ["plugin", "validate", marketplaceRoot]);
  }

  install(request: { marketplaceRoot: string; marketplaceName: string; pluginName: string }): ProviderPluginProbe {
    this.uninstall({ marketplaceName: request.marketplaceName, pluginName: request.pluginName });
    this.run(this.executable, ["plugin", "marketplace", "add", request.marketplaceRoot, "--scope", "user"]);
    this.run(this.executable, [
      "plugin",
      "install",
      pluginIdentity(request.pluginName, request.marketplaceName),
      "--scope",
      "user",
    ]);
    const result = this.probe(request.marketplaceName, request.pluginName);
    if (!result.installed || !result.enabled) {
      throw new Error("Claude Code did not report the First Tree Context Plugin as installed and enabled.");
    }
    return result;
  }

  uninstall(request: { marketplaceName: string; pluginName: string }): void {
    const identity = pluginIdentity(request.pluginName, request.marketplaceName);
    const probe = this.probe(request.marketplaceName, request.pluginName);
    if (!probe.binaryAvailable) {
      throw new Error("Claude Code is unavailable, so First Tree cannot verify or remove its user-scope Plugin.");
    }
    if (probe.issues.includes("Claude Code Plugin state could not be inspected.")) {
      throw new Error("Claude Code Plugin state could not be inspected safely; no uninstall was attempted.");
    }
    if (probe.installed) {
      this.run(this.executable, ["plugin", "uninstall", identity, "--scope", "user", "--yes"]);
    }
    const marketplaces = JSON.parse(this.run(this.executable, ["plugin", "marketplace", "list", "--json"]).stdout);
    if (JSON.stringify(marketplaces).includes(request.marketplaceName)) {
      this.run(this.executable, ["plugin", "marketplace", "remove", request.marketplaceName]);
    }
  }
}

function resolveClaudeInstalledPluginPath(
  marketplaceName: string,
  pluginName: string,
  version: string | null,
): string | null {
  if (!version) return null;
  const path = join(
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
    "plugins",
    "cache",
    marketplaceName,
    pluginName,
    version,
  );
  return existsSync(path) ? path : null;
}
