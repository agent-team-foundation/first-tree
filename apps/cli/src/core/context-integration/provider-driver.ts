import type { ContextIntegrationProvider } from "@first-tree/shared";

export type ProviderPluginProbe = {
  provider: ContextIntegrationProvider;
  binaryAvailable: boolean;
  version: string | null;
  compatible: boolean;
  installed: boolean;
  enabled: boolean;
  installedPath: string | null;
  issues: string[];
};

export type ProviderHookTrust = "trusted" | "review_required" | "modified" | "provider_managed" | "unknown";

export type ProviderHookProbe = {
  trust: ProviderHookTrust;
  enabled: boolean | null;
  source: "provider_api" | "provider_managed" | "unavailable";
  issues: string[];
};

export type ProviderHookInspectRequest = {
  marketplaceName: string;
  pluginName: string;
  cwd: string;
  plugin: Pick<ProviderPluginProbe, "installed" | "enabled">;
};

export type ProviderInstallRequest = {
  marketplaceRoot: string;
  marketplaceName: string;
  pluginName: string;
};

export type ProviderCommandResult = {
  stdout: string;
  stderr: string;
};

export type ProviderCommandRunner = (executable: string, args: readonly string[]) => ProviderCommandResult;

export interface ContextIntegrationProviderDriver {
  readonly provider: ContextIntegrationProvider;
  readonly executable: string;
  readonly minimumVersion: string;
  probe(marketplaceName: string, pluginName: string): ProviderPluginProbe;
  inspectHook(request: ProviderHookInspectRequest): Promise<ProviderHookProbe>;
  validateMarketplace(marketplaceRoot: string): void;
  install(request: ProviderInstallRequest): ProviderPluginProbe;
  uninstall(request: Omit<ProviderInstallRequest, "marketplaceRoot">): void;
}

export class ProviderCommandError extends Error {
  constructor(
    readonly executable: string,
    readonly args: readonly string[],
    readonly stderr: string,
    options?: ErrorOptions,
  ) {
    super(`${executable} ${args.join(" ")} failed${stderr.trim() ? `: ${stderr.trim()}` : "."}`, options);
    this.name = "ProviderCommandError";
  }
}

export function parseProviderVersion(output: string): string | null {
  return output.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/u)?.[1] ?? null;
}

export function pluginIdentity(pluginName: string, marketplaceName: string): string {
  return `${pluginName}@${marketplaceName}`;
}
