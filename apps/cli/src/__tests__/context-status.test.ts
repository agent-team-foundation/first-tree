import type { ContextActivationResponse } from "@first-tree/shared";
import { describe, expect, it, vi } from "vitest";
import { buildContextEnableNextActions } from "../commands/context/enable.js";
import { renderHookEnabled, renderHookTrust } from "../commands/context/status.js";
import type { ContextActivationValidator } from "../core/context-integration/activation.js";
import {
  ContextClientPreflightError,
  contextClientPreflightErrorCode,
} from "../core/context-integration/client-preflight.js";
import type {
  ContextIntegrationProviderDriver,
  ProviderPluginProbe,
} from "../core/context-integration/provider-driver.js";
import { inspectContextIntegrationStatus } from "../core/context-integration/status.js";

function pluginProbe(overrides: Partial<ProviderPluginProbe> = {}): ProviderPluginProbe {
  return {
    provider: "codex",
    binaryAvailable: true,
    version: "0.146.0",
    compatible: true,
    installed: true,
    enabled: true,
    installedPath: "/provider/cache/first-tree-context",
    issues: [],
    ...overrides,
  };
}

function driver(probe = pluginProbe()): ContextIntegrationProviderDriver {
  return {
    provider: "codex",
    executable: "codex",
    minimumVersion: "0.144.0",
    probe: () => probe,
    inspectHook: async () => ({
      trust: "trusted",
      enabled: true,
      source: "provider_api",
      issues: [],
    }),
    validateMarketplace: () => undefined,
    install: () => probe,
    uninstall: () => undefined,
  };
}

function validator(response: ContextActivationResponse): ContextActivationValidator {
  return {
    validateMemberContextActivation: vi.fn(async () => response),
  };
}

describe("Context integration layered status", () => {
  it("reports provider, Plugin, Hook, checkout, exact binding, and live activation independently", async () => {
    const value = await inspectContextIntegrationStatus(
      driver(),
      validator({
        schemaVersion: 1,
        outcome: "connected",
        team: {
          organizationId: "org_acme",
          displayName: "Acme",
          role: "admin",
        },
      }),
      "/work/repo",
      {
        inspectRuntime: (runtimeDriver) => ({
          provider: "codex",
          healthy: true,
          issues: [],
          install: null,
          release: null,
          probe: runtimeDriver.probe("first-tree-dev", "first-tree-context"),
        }),
        inspectPreflight: () => ({
          checkoutRoot: "/work/repo",
          repositoryKey: "github.com/acme/repo",
          originUrl: "git@github.com:acme/repo.git",
        }),
        findBinding: () => ({
          provider: "codex",
          checkoutRoot: "/work/repo",
          repositoryKey: "github.com/acme/repo",
          organizationId: "org_acme",
        }),
      },
    );

    expect(value).toMatchObject({
      provider: { available: true, compatible: true, version: "0.146.0" },
      plugin: { installed: true, enabled: true },
      hook: { trust: "trusted", enabled: true },
      checkout: { state: "ready", root: "/work/repo" },
      binding: { state: "exact", organizationId: "org_acme" },
      activation: { state: "connected", team: { displayName: "Acme" } },
    });
  });

  it.each([
    [contextClientPreflightErrorCode.notSignedIn, "First Tree is not signed in.", "Run `first-tree login <code>`."],
    [
      contextClientPreflightErrorCode.notGitCheckout,
      "The current directory is not a Git checkout.",
      "Run this command inside the target Git checkout.",
    ],
    [
      contextClientPreflightErrorCode.originUnreadable,
      "The current Git checkout has no readable `origin` remote.",
      "Add or repair `origin`.",
    ],
  ])("preserves the %s checkout failure and repair action", async (code, message, nextAction) => {
    const value = await inspectContextIntegrationStatus(
      driver(),
      validator({
        schemaVersion: 1,
        outcome: "connected",
        team: {
          organizationId: "org_acme",
          displayName: "Acme",
          role: "member",
        },
      }),
      "/work/repo",
      {
        inspectRuntime: (runtimeDriver) => ({
          provider: "codex",
          healthy: true,
          issues: [],
          install: null,
          release: null,
          probe: runtimeDriver.probe("first-tree-dev", "first-tree-context"),
        }),
        inspectPreflight: () => {
          throw new ContextClientPreflightError(code, message, nextAction);
        },
      },
    );

    expect(value.checkout).toEqual({
      state: "unavailable",
      reason: code,
      message,
      nextAction,
    });
    expect(value.binding.state).toBe("not_checked");
    expect(value.activation.state).toBe("not_checked");
  });

  it("keeps exact binding visible when live activation is unavailable", async () => {
    const unavailable: ContextActivationValidator = {
      validateMemberContextActivation: vi.fn(async () => {
        throw new Error("network timeout");
      }),
    };
    const value = await inspectContextIntegrationStatus(driver(), unavailable, "/work/repo", {
      inspectRuntime: (runtimeDriver) => ({
        provider: "codex",
        healthy: true,
        issues: [],
        install: null,
        release: null,
        probe: runtimeDriver.probe("first-tree-dev", "first-tree-context"),
      }),
      inspectPreflight: () => ({
        checkoutRoot: "/work/repo",
        repositoryKey: "github.com/acme/repo",
        originUrl: "https://github.com/acme/repo.git",
      }),
      findBinding: () => ({
        provider: "codex",
        checkoutRoot: "/work/repo",
        repositoryKey: "github.com/acme/repo",
        organizationId: "org_acme",
      }),
    });

    expect(value.binding).toMatchObject({ state: "exact", organizationId: "org_acme" });
    expect(value.activation).toMatchObject({
      state: "unavailable",
      message: expect.stringContaining("network timeout"),
    });
  });
});

describe("Context enable Hook guidance", () => {
  it("guides pending Codex consent through every verifiable step", () => {
    const actions = buildContextEnableNextActions(
      "codex",
      {
        trust: "review_required",
        enabled: false,
      },
      "first-tree-staging",
    );

    expect(actions).toEqual([
      "Open Codex in this checkout.",
      "Run `/hooks`.",
      "Find First Tree Context → SessionStart, enable its checkbox, and choose Trust.",
      "Exit and start a new Codex session in this checkout.",
      "Run `first-tree-staging context status --provider codex`; confirm Hook trusted/enabled are Yes and Live activation is Connected.",
    ]);
  });

  it("does not ask for another review after Codex reports trusted and enabled", () => {
    const actions = buildContextEnableNextActions(
      "codex",
      {
        trust: "trusted",
        enabled: true,
      },
      "first-tree-staging",
    );

    expect(actions.join(" ")).not.toContain("/hooks");
    expect(renderHookTrust({ trust: "trusted", enabled: true, source: "provider_api", issues: [] })).toBe("Yes");
    expect(renderHookEnabled({ trust: "trusted", enabled: true, source: "provider_api", issues: [] })).toBe("Yes");
  });
});
