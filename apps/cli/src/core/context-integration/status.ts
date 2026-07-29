import type {
  ContextActivationResponse,
  ContextIntegrationBinding,
  ContextIntegrationProvider,
} from "@first-tree/shared";
import semver from "semver";
import { channelConfig } from "../channel.js";
import type { ContextActivationValidator } from "./activation.js";
import {
  ContextClientPreflightError,
  type ContextClientPreflightErrorCode,
  inspectContextClientPreflight,
} from "./client-preflight.js";
import { findContextBinding } from "./context-binding-store.js";
import { contextIntegrationMarketplaceName } from "./installer.js";
import type { ContextIntegrationProviderDriver, ProviderHookProbe, ProviderPluginProbe } from "./provider-driver.js";
import { type ContextIntegrationRuntimeHealth, inspectContextIntegrationRuntime } from "./runtime-health.js";

type CheckoutStatus =
  | {
      state: "ready";
      root: string;
      repositoryKey: string;
    }
  | {
      state: "unavailable";
      reason: ContextClientPreflightErrorCode | "unknown";
      message: string;
      nextAction: string;
    };

type BindingStatus =
  | {
      state: "exact";
      organizationId: string;
      repositoryKey: string;
    }
  | {
      state: "missing";
      nextAction: string;
    }
  | {
      state: "repository_mismatch";
      organizationId: string;
      boundRepositoryKey: string;
      currentRepositoryKey: string;
      nextAction: string;
    }
  | {
      state: "not_checked";
      reason: string;
    };

type LiveActivationStatus =
  | {
      state: "connected";
      team: Extract<ContextActivationResponse, { outcome: "connected" }>["team"];
    }
  | {
      state: "disabled";
      reasonCode: string;
      message: string;
      settingsUrl: string | null;
    }
  | {
      state: "needs_admin";
      reasonCode: string;
      message: string;
      settingsUrl: string | null;
    }
  | {
      state: "unavailable";
      message: string;
      nextAction: string;
    }
  | {
      state: "not_checked";
      reason: string;
    };

export type ContextIntegrationStatus = {
  provider: {
    name: ContextIntegrationProvider;
    available: boolean;
    version: string | null;
    minimumVersion: string;
    compatible: boolean;
  };
  plugin: {
    installed: boolean;
    enabled: boolean;
    installedPath: string | null;
  };
  hook: ProviderHookProbe;
  runtime: {
    healthy: boolean;
    issues: string[];
  };
  checkout: CheckoutStatus;
  binding: BindingStatus;
  activation: LiveActivationStatus;
};

type StatusDependencies = {
  inspectRuntime?: (driver: ContextIntegrationProviderDriver) => ContextIntegrationRuntimeHealth;
  inspectPreflight?: typeof inspectContextClientPreflight;
  findBinding?: (provider: ContextIntegrationProvider, checkoutRoot: string) => ContextIntegrationBinding | null;
};

export async function inspectContextIntegrationStatus(
  driver: ContextIntegrationProviderDriver,
  validator: ContextActivationValidator,
  cwd = process.cwd(),
  dependencies: StatusDependencies = {},
): Promise<ContextIntegrationStatus> {
  const inspectRuntime = dependencies.inspectRuntime ?? inspectContextIntegrationRuntime;
  const inspectPreflight = dependencies.inspectPreflight ?? inspectContextClientPreflight;
  const resolveBinding = dependencies.findBinding ?? findContextBinding;
  const health = inspectRuntime(driver);
  const plugin = health.probe;
  const marketplaceName = health.install?.marketplaceName ?? contextIntegrationMarketplaceName();
  const pluginName = health.install?.pluginName ?? "first-tree-context";
  const hook = await inspectProviderHook(driver, plugin, {
    marketplaceName,
    pluginName,
    cwd,
  });
  const minimumVersion = health.release?.manifest.providers[driver.provider].minimumVersion ?? driver.minimumVersion;

  const providerStatus = {
    name: driver.provider,
    available: plugin.binaryAvailable,
    version: plugin.version,
    minimumVersion,
    compatible:
      plugin.binaryAvailable &&
      plugin.version !== null &&
      semver.valid(plugin.version) !== null &&
      semver.gte(plugin.version, minimumVersion),
  };
  const pluginStatus = {
    installed: plugin.installed,
    enabled: plugin.enabled,
    installedPath: plugin.installedPath,
  };
  const runtime = {
    healthy: health.healthy,
    issues: health.issues,
  };

  let preflight: ReturnType<typeof inspectContextClientPreflight>;
  try {
    preflight = inspectPreflight(cwd);
  } catch (error) {
    const checkout = checkoutFailure(error);
    return {
      provider: providerStatus,
      plugin: pluginStatus,
      hook,
      runtime,
      checkout,
      binding: {
        state: "not_checked",
        reason: checkout.message,
      },
      activation: {
        state: "not_checked",
        reason: checkout.message,
      },
    };
  }

  const checkout: CheckoutStatus = {
    state: "ready",
    root: preflight.checkoutRoot,
    repositoryKey: preflight.repositoryKey,
  };
  let binding: ContextIntegrationBinding | null;
  try {
    binding = resolveBinding(driver.provider, preflight.checkoutRoot);
  } catch (error) {
    const reason = `The exact checkout binding could not be read: ${message(error)}`;
    return {
      provider: providerStatus,
      plugin: pluginStatus,
      hook,
      runtime,
      checkout,
      binding: { state: "not_checked", reason },
      activation: { state: "not_checked", reason },
    };
  }
  if (!binding) {
    return {
      provider: providerStatus,
      plugin: pluginStatus,
      hook,
      runtime,
      checkout,
      binding: {
        state: "missing",
        nextAction: `Run the target Team's \`${channelConfig.binName} context enable\` handoff in this checkout.`,
      },
      activation: {
        state: "not_checked",
        reason: "No exact provider + checkout binding exists.",
      },
    };
  }
  if (binding.repositoryKey !== preflight.repositoryKey) {
    return {
      provider: providerStatus,
      plugin: pluginStatus,
      hook,
      runtime,
      checkout,
      binding: {
        state: "repository_mismatch",
        organizationId: binding.organizationId,
        boundRepositoryKey: binding.repositoryKey,
        currentRepositoryKey: preflight.repositoryKey,
        nextAction: "Restore the bound `origin` or rerun the target Team's enable handoff.",
      },
      activation: {
        state: "not_checked",
        reason: "The checkout `origin` no longer matches its exact binding.",
      },
    };
  }

  const bindingStatus: BindingStatus = {
    state: "exact",
    organizationId: binding.organizationId,
    repositoryKey: binding.repositoryKey,
  };
  try {
    const response = await validator.validateMemberContextActivation(
      binding.organizationId,
      {
        schemaVersion: 1,
        repositoryKey: binding.repositoryKey,
      },
      { retry: false, timeoutMs: 2_000 },
    );
    return {
      provider: providerStatus,
      plugin: pluginStatus,
      hook,
      runtime,
      checkout,
      binding: bindingStatus,
      activation: activationStatus(response),
    };
  } catch (error) {
    return {
      provider: providerStatus,
      plugin: pluginStatus,
      hook,
      runtime,
      checkout,
      binding: bindingStatus,
      activation: {
        state: "unavailable",
        message: `First Tree live activation could not be checked: ${message(error)}`,
        nextAction: `Check the First Tree connection and rerun \`${channelConfig.binName} context status --provider ${driver.provider}\`.`,
      },
    };
  }
}

function inspectProviderHook(
  driver: ContextIntegrationProviderDriver,
  plugin: ProviderPluginProbe,
  input: {
    marketplaceName: string;
    pluginName: string;
    cwd: string;
  },
): Promise<ProviderHookProbe> {
  return driver.inspectHook({
    ...input,
    plugin: {
      installed: plugin.installed,
      enabled: plugin.enabled,
    },
  });
}

function checkoutFailure(error: unknown): Extract<CheckoutStatus, { state: "unavailable" }> {
  if (error instanceof ContextClientPreflightError) {
    return {
      state: "unavailable",
      reason: error.code,
      message: error.message,
      nextAction: error.nextAction,
    };
  }
  return {
    state: "unavailable",
    reason: "unknown",
    message: `The current checkout could not be inspected: ${message(error)}`,
    nextAction: `Fix the reported checkout error, then rerun \`${channelConfig.binName} context status\`.`,
  };
}

function activationStatus(response: ContextActivationResponse): LiveActivationStatus {
  if (response.outcome === "connected") {
    return {
      state: "connected",
      team: response.team,
    };
  }
  return {
    state: response.outcome,
    reasonCode: response.reasonCode,
    message: response.nextAction.message,
    settingsUrl: response.nextAction.settingsUrl ?? null,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
