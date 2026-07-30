import type { ContextActivationResponse } from "@first-tree/shared";
import { describe, expect, it, vi } from "vitest";
import {
  buildContextEnableNextActions,
  buildSetupNextActions,
  collectMissingSetupLayers,
  collectSetupRecoveryActions,
  renderSetupVerdictLine,
} from "../commands/context/enable.js";
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
import { ClaudeCodeContextIntegrationDriver } from "../core/context-integration/providers/claude-code.js";
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

  it("uses the release manifest minimum when computing provider compatibility", async () => {
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
          healthy: false,
          issues: ["codex 0.146.0 must be upgraded to 0.147.0 or newer."],
          install: null,
          release: {
            root: "/release",
            manifest: {
              schemaVersion: 1,
              version: "0.5.18",
              channel: "dev",
              bundleDigest: `sha256:${"1".repeat(64)}`,
              policyDigest: `sha256:${"2".repeat(64)}`,
              providers: {
                "claude-code": {
                  adapterDigest: `sha256:${"3".repeat(64)}`,
                  minimumVersion: "2.1.121",
                },
                codex: {
                  adapterDigest: `sha256:${"4".repeat(64)}`,
                  minimumVersion: "0.147.0",
                },
              },
            },
          },
          probe: runtimeDriver.probe("first-tree-dev", "first-tree-context"),
        }),
        inspectPreflight: () => {
          throw new ContextClientPreflightError(
            contextClientPreflightErrorCode.notGitCheckout,
            "The current directory is not a Git checkout.",
            "Run this command inside the target Git checkout.",
          );
        },
      },
    );

    expect(value.provider).toMatchObject({
      version: "0.146.0",
      minimumVersion: "0.147.0",
      compatible: false,
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
    const validate = vi.fn(async () => {
      throw new Error("network timeout");
    });
    const unavailable: ContextActivationValidator = {
      validateMemberContextActivation: validate,
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
      reasonCode: "authority_timeout",
      message: expect.stringContaining("timed out"),
    });
    expect(validate).toHaveBeenCalledTimes(2);
    expect(validate).toHaveBeenNthCalledWith(
      1,
      "org_acme",
      {
        schemaVersion: 1,
        repositoryKey: "github.com/acme/repo",
      },
      { retry: false, timeoutMs: 5_000 },
    );
    expect(validate).toHaveBeenNthCalledWith(
      2,
      "org_acme",
      {
        schemaVersion: 1,
        repositoryKey: "github.com/acme/repo",
      },
      { retry: false, timeoutMs: 5_000 },
    );
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
      "Re-run the same `first-tree-staging context enable` command; setup is complete only when it reports Setup: Complete.",
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

  it("asks only for enablement when the Codex Hook is already trusted", () => {
    const actions = buildContextEnableNextActions(
      "codex",
      {
        trust: "trusted",
        enabled: false,
      },
      "first-tree-staging",
    );

    expect(actions.join(" ")).toContain("enable its checkbox");
    expect(actions.join(" ")).not.toContain("choose Trust");
  });
});

describe("Context enable setup verdict", () => {
  const greenVerification = {
    provider: { name: "codex" as const, available: true, version: "1.0.0", minimumVersion: "0.5.0", compatible: true },
    plugin: { installed: true, enabled: true, installedPath: "/tmp/plugin" },
    hook: { trust: "trusted" as const, enabled: true, source: "provider_api" as const, issues: [] },
    runtime: { healthy: true, issues: [] },
    checkout: { state: "ready" as const, root: "/work/repo", repositoryKey: "github.com/acme/repo" },
    binding: { state: "exact" as const, organizationId: "org-1", repositoryKey: "github.com/acme/repo" },
    activation: {
      state: "connected" as const,
      team: { organizationId: "org-1", displayName: "Acme", role: "member" as const },
    },
  };

  it("reports complete only when every layer is green", () => {
    expect(collectMissingSetupLayers("codex", greenVerification)).toEqual([]);
    expect(collectMissingSetupLayers("claude-code", greenVerification)).toEqual([]);
  });

  it("lists the missing Codex hook layers", () => {
    expect(
      collectMissingSetupLayers("codex", {
        ...greenVerification,
        hook: { trust: "review_required", enabled: false, source: "provider_api", issues: [] },
      }),
    ).toEqual(["Hook trusted: No", "Hook enabled: No"]);
  });

  it("ignores hook layers for Claude Code and flags binding and activation drift", () => {
    expect(
      collectMissingSetupLayers("claude-code", {
        ...greenVerification,
        hook: { trust: "provider_managed", enabled: false, source: "provider_managed", issues: [] },
        binding: { state: "missing", nextAction: "Run context enable from the target checkout." },
        activation: { state: "not_checked", reason: "binding missing" },
      }),
    ).toEqual(["Exact binding: missing", "Live activation: not_checked"]);
  });

  it("renders the literal verdict anchor the setup prompt requires", () => {
    expect(renderSetupVerdictLine({ complete: true, missingLayers: [] })).toBe(
      "Setup: Complete — every layer verified",
    );
    expect(renderSetupVerdictLine({ complete: false, missingLayers: ["Hook trusted: No", "Hook enabled: No"] })).toBe(
      "Setup: Incomplete — Hook trusted: No; Hook enabled: No",
    );
  });

  it("stays Incomplete when the installed payload is unhealthy despite green plugin flags", () => {
    expect(
      collectMissingSetupLayers("claude-code", {
        ...greenVerification,
        runtime: { healthy: false, issues: ["The installed Plugin payload does not match the current release."] },
      }),
    ).toEqual(["Plugin payload healthy: No"]);
    expect(
      collectMissingSetupLayers("codex", {
        ...greenVerification,
        provider: { ...greenVerification.provider, compatible: false },
      }),
    ).toEqual(["Provider compatible: No"]);
  });

  it("flags an unavailable checkout as its own layer", () => {
    expect(
      collectMissingSetupLayers("claude-code", {
        ...greenVerification,
        checkout: {
          state: "unavailable",
          reason: "not_signed_in",
          message: "First Tree is not signed in.",
          nextAction: "Run `first-tree-staging login <code>`, then rerun this command.",
        },
        binding: { state: "not_checked", reason: "checkout unavailable" },
        activation: { state: "not_checked", reason: "checkout unavailable" },
      }),
    ).toEqual(["Checkout: unavailable", "Exact binding: not_checked", "Live activation: not_checked"]);
  });
});

describe("Context enable recovery actions", () => {
  const greenVerification = {
    provider: { name: "codex" as const, available: true, version: "1.0.0", minimumVersion: "0.5.0", compatible: true },
    runtime: { healthy: true, issues: [] },
    hook: { trust: "trusted" as const, enabled: true, source: "provider_api" as const, issues: [] },
    checkout: { state: "ready" as const, root: "/work/repo", repositoryKey: "github.com/acme/repo" },
    binding: { state: "exact" as const, organizationId: "org-1", repositoryKey: "github.com/acme/repo" },
    activation: {
      state: "connected" as const,
      team: { organizationId: "org-1", displayName: "Acme", role: "member" as const },
    },
  };

  it("returns nothing when every layer is green", () => {
    expect(collectSetupRecoveryActions("claude-code", greenVerification, "first-tree-staging")).toEqual([]);
  });

  it("surfaces a repair step for an unhealthy payload", () => {
    const actions = collectSetupRecoveryActions(
      "claude-code",
      {
        ...greenVerification,
        runtime: { healthy: false, issues: ["The installed Plugin payload does not match the current release."] },
      },
      "first-tree-staging",
    );
    expect(actions).toEqual([
      "The installed Plugin payload does not match the current release. Run `first-tree-staging context repair --provider claude-code`.",
    ]);
  });

  it("keeps a transient activation failure actionable", () => {
    const actions = collectSetupRecoveryActions(
      "claude-code",
      {
        ...greenVerification,
        activation: {
          state: "unavailable",
          reasonCode: "validation_unavailable",
          message: "First Tree could not validate Team Context.",
          nextAction: "Check connectivity and re-run this command.",
        },
      },
      "first-tree-staging",
    );
    expect(actions).toEqual([
      "First Tree could not validate Team Context. Check connectivity and re-run this command.",
    ]);
  });

  it("passes through the binding repair instruction", () => {
    const actions = collectSetupRecoveryActions(
      "codex",
      {
        ...greenVerification,
        binding: { state: "missing", nextAction: "Run context enable from the target checkout." },
      },
      "first-tree-staging",
    );
    expect(actions).toEqual(["Run context enable from the target checkout."]);
  });

  it("surfaces the checkout repair when the second preflight fails", () => {
    const actions = collectSetupRecoveryActions(
      "claude-code",
      {
        ...greenVerification,
        checkout: {
          state: "unavailable",
          reason: "not_signed_in",
          message: "First Tree is not signed in.",
          nextAction: "Run `first-tree-staging login <code>`, then rerun this command.",
        },
        binding: { state: "not_checked", reason: "checkout unavailable" },
        activation: { state: "not_checked", reason: "checkout unavailable" },
      },
      "first-tree-staging",
    );
    expect(actions).toEqual([
      "First Tree is not signed in. Run `first-tree-staging login <code>`, then rerun this command.",
    ]);
  });

  it("surfaces the unreadable-binding diagnostic for Claude Code", () => {
    const reason =
      "The exact checkout binding could not be read: Invalid First Tree Context binding config at /home/u/.first-tree/config/context.yaml.";
    const verification = {
      ...greenVerification,
      hook: { trust: "provider_managed" as const, enabled: false, source: "provider_managed" as const, issues: [] },
      binding: { state: "not_checked" as const, reason },
      activation: { state: "not_checked" as const, reason },
    };
    const actions = buildSetupNextActions(
      "claude-code",
      verification,
      { complete: false, missingLayers: ["Exact binding: not_checked", "Live activation: not_checked"] },
      "first-tree-staging",
    );
    expect(actions).toEqual([
      `${reason} Re-run this \`first-tree-staging context enable\` command; if the failure persists, do not delete the binding config — it also holds bindings for other providers and checkouts. Back it up, then repair its file permissions or YAML together with the member before retrying.`,
    ]);
    expect(actions[0]).not.toMatch(/remove/i);
  });

  it("keeps the binding diagnostic ahead of the trusted-Hook Codex status reminder", () => {
    const reason = "The exact checkout binding could not be read: EACCES: permission denied.";
    const verification = {
      ...greenVerification,
      binding: { state: "not_checked" as const, reason },
      activation: { state: "not_checked" as const, reason },
    };
    const actions = buildSetupNextActions(
      "codex",
      verification,
      { complete: false, missingLayers: ["Exact binding: not_checked", "Live activation: not_checked"] },
      "first-tree-staging",
    );
    expect(actions).toEqual([
      `${reason} Re-run this \`first-tree-staging context enable\` command; if the failure persists, do not delete the binding config — it also holds bindings for other providers and checkouts. Back it up, then repair its file permissions or YAML together with the member before retrying.`,
      "Run `first-tree-staging context status --provider codex` to verify every layer remains connected.",
    ]);
    expect(actions[0]).not.toMatch(/remove/i);
  });

  it("never leaves an Incomplete verdict without a next step", () => {
    const actions = buildSetupNextActions(
      "claude-code",
      {
        ...greenVerification,
        hook: { trust: "provider_managed" as const, enabled: false, source: "provider_managed" as const, issues: [] },
      },
      { complete: false, missingLayers: ["Plugin enabled: No"] },
      "first-tree-staging",
    );
    expect(actions).toEqual([
      "Fix the layers listed in the Setup line, then re-run this `first-tree-staging context enable` command.",
    ]);
  });
});

describe("provider-aware Hook rendering", () => {
  it("renders a disabled Claude Hook as Plugin-managed", () => {
    const hook = {
      trust: "provider_managed" as const,
      enabled: false,
      source: "provider_managed" as const,
      issues: [],
    };

    expect(renderHookTrust(hook)).toBe("Managed by provider");
    expect(renderHookEnabled(hook)).toBe("No — enable the First Tree Context Plugin in Claude Code");
  });

  it("does not claim a provider-managed Hook when the Claude Plugin is absent", async () => {
    const claudeDriver = new ClaudeCodeContextIntegrationDriver(() => ({ stdout: "", stderr: "" }));
    const hook = await claudeDriver.inspectHook({
      marketplaceName: "first-tree-dev",
      pluginName: "first-tree-context",
      cwd: "/work/repo",
      plugin: { installed: false, enabled: false },
    });

    expect(hook).toEqual({
      trust: "unknown",
      enabled: null,
      source: "unavailable",
      issues: [],
    });
    expect(renderHookTrust(hook)).toBe("Not available");
    expect(renderHookEnabled(hook)).toBe("Not available");
  });
});
