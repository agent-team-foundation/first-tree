import type { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../commands/types.js";

const output = vi.hoisted(() => ({
  result: vi.fn(),
  fail: vi.fn((code: string, message: string) => {
    throw Object.assign(new Error(message), { code });
  }),
  line: vi.fn(),
  status: vi.fn(),
}));
const mocks = vi.hoisted(() => ({
  assertFingerprint: vi.fn(),
  buildHandoff: vi.fn(),
  createDriver: vi.fn(),
  enableOperation: vi.fn(),
  fingerprintAfter: vi.fn(() => "b".repeat(64)),
  inspectHook: vi.fn(),
  inspectLocation: vi.fn(),
  inspectRuntime: vi.fn(),
  inspectStore: vi.fn(),
  issueSession: vi.fn(),
  planInstall: vi.fn(),
  readAccount: vi.fn(() => "client-1"),
  readConfig: vi.fn(),
  resolveRelease: vi.fn(),
  validateActivation: vi.fn(),
  channelConfig: { channel: "dev", binName: "first-tree-dev" },
}));

vi.mock("../core/output.js", () => ({ print: output }));
vi.mock("../core/channel.js", () => ({ channelConfig: mocks.channelConfig }));
vi.mock("../core/context-integration/account-state-guard.js", () => ({
  readActiveContextAccountClientId: mocks.readAccount,
  withAccountStateMutationLockAsync: (action: () => Promise<unknown>) => action(),
}));
vi.mock("../core/context-integration/client-preflight.js", () => ({
  inspectContextSetupLocation: mocks.inspectLocation,
}));
vi.mock("../core/context-integration/context-binding-store.js", () => ({
  assertContextGrantStoreFingerprint: mocks.assertFingerprint,
  contextGrantStoreFingerprintAfterGrant: mocks.fingerprintAfter,
  inspectContextGrantStore: mocks.inspectStore,
  readContextIntegrationConfig: mocks.readConfig,
}));
vi.mock("../core/context-integration/current-session-handoff.js", () => ({
  buildCurrentSessionHandoff: mocks.buildHandoff,
}));
vi.mock("../core/context-integration/installer.js", () => ({
  planContextIntegrationInstall: mocks.planInstall,
}));
vi.mock("../core/context-integration/operation.js", () => ({
  enableContextIntegrationOperation: mocks.enableOperation,
}));
vi.mock("../core/context-integration/release.js", () => ({
  providerPluginRoot: () => "/release/providers/codex",
  resolveContextIntegrationRelease: mocks.resolveRelease,
}));
vi.mock("../core/context-integration/runtime-health.js", () => ({
  inspectContextIntegrationRuntime: mocks.inspectRuntime,
}));
vi.mock("../commands/_shared/member.js", () => ({
  createMemberSdk: () => ({
    validateMemberContextActivation: mocks.validateActivation,
    issueMemberContextSessionCandidate: mocks.issueSession,
  }),
}));
vi.mock("../commands/context/shared.js", () => ({
  createContextIntegrationDriver: mocks.createDriver,
  parseContextProvider: (value: string) => value,
}));

import { runContextEnable } from "../commands/context/enable.js";

const team = { organizationId: "org-a", displayName: "Team A", role: "member" as const };
const project = { kind: "path" as const, root: "/work/repo" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.channelConfig.channel = "dev";
  mocks.channelConfig.binName = "first-tree-dev";
  mocks.readAccount.mockReturnValue("client-1");
  mocks.inspectLocation.mockReturnValue({
    project,
    directory: "/work/repo",
    directoryAvailable: true,
    temporaryDirectory: false,
    warning: null,
  });
  mocks.inspectStore.mockReturnValue({
    kind: "missing",
    config: { schemaVersion: 3, grants: [] },
    fingerprint: "a".repeat(64),
  });
  mocks.resolveRelease.mockReturnValue({ root: "/release" });
  mocks.validateActivation.mockResolvedValue({ schemaVersion: 2, outcome: "connected", team });
  mocks.issueSession.mockResolvedValue({ receipt: "signed-session" });
  mocks.buildHandoff.mockReturnValue({ schemaVersion: 2, consumerKind: "byo", provider: "codex", project });
  mocks.readConfig.mockReturnValue({
    schemaVersion: 3,
    grants: [{ provider: "codex", organizationId: "org-a", activationScope: { kind: "global" } }],
  });
  mocks.planInstall.mockReturnValue({ operation: "unchanged" });
  mocks.inspectHook.mockResolvedValue({ trust: "trusted", enabled: true, source: "provider_api", issues: [] });
  mocks.createDriver.mockReturnValue({ provider: "codex", inspectHook: mocks.inspectHook });
  mocks.inspectRuntime.mockReturnValue({
    healthy: true,
    issues: [],
    probe: { installed: true, enabled: true, installedPath: "/plugin" },
    install: { marketplaceName: "first-tree", pluginName: "first-tree-context" },
  });
});

describe("context enable v3 command", () => {
  it("keeps plan read-only and fixes the grant-store fingerprint", async () => {
    await runContextEnable(context({ plan: true }));
    const result = output.result.mock.calls[0]?.[0] as {
      plan: {
        planId: string;
        grantStoreFingerprint: string;
        choices: Array<{ kind: string; applyCommand: string | null }>;
      };
    };
    expect(result.plan.grantStoreFingerprint).toBe("a".repeat(64));
    expect(result.plan.planId).toContain(`.${"a".repeat(64)}.`);
    expect(result.plan.choices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "global",
          applyCommand: `'first-tree-dev' --json context enable --provider 'codex' --team 'org-a' --scope 'global' --plan-id '${result.plan.planId}' --yes`,
        }),
        expect.objectContaining({
          kind: "directory",
          applyCommand: `'first-tree-dev' --json context enable --provider 'codex' --team 'org-a' --scope 'directory' --plan-id '${result.plan.planId}' --yes`,
        }),
        expect.objectContaining({
          kind: "session",
          applyCommand: `'first-tree-dev' --json context enable --provider 'codex' --team 'org-a' --scope 'session' --plan-id '${result.plan.planId}' --yes`,
        }),
      ]),
    );
    expect(mocks.enableOperation).not.toHaveBeenCalled();
    expect(mocks.issueSession).not.toHaveBeenCalled();
    expect(mocks.assertFingerprint).not.toHaveBeenCalled();
  });

  it("omits an apply command for an unavailable directory choice", async () => {
    mocks.inspectLocation.mockReturnValue({
      project: { kind: "pathless" },
      directory: null,
      directoryAvailable: false,
      temporaryDirectory: false,
      warning: null,
    });
    await runContextEnable(context({ plan: true, projectRoot: undefined, pathless: true }));
    const result = output.result.mock.calls[0]?.[0] as {
      plan: { choices: Array<{ kind: string; available: boolean; applyCommand: string | null }> };
    };
    expect(result.plan.choices.find((choice) => choice.kind === "directory")).toMatchObject({
      available: false,
      applyCommand: null,
    });
  });

  it("renders exact apply commands in the human-readable plan", async () => {
    await runContextEnable({ ...context({ plan: true }), options: { json: false, debug: false, quiet: false } });
    const statusRows = output.status.mock.calls.map(([label, value]) => `${label}: ${value}`).join("\n");
    expect(statusRows).toContain(
      `Apply command: 'first-tree-dev' --json context enable --provider 'codex' --team 'org-a' --scope 'global'`,
    );
    expect(statusRows).toContain("Next: Choose one scope, then run its exact apply command unchanged.");
  });

  it("pins non-dev apply commands to the portable executable without quoting away tilde expansion", async () => {
    mocks.channelConfig.channel = "staging";
    mocks.channelConfig.binName = "first-tree-staging";
    await runContextEnable(context({ plan: true }));
    const result = output.result.mock.calls[0]?.[0] as {
      plan: { choices: Array<{ kind: string; applyCommand: string | null }> };
    };
    expect(result.plan.choices.find((choice) => choice.kind === "global")?.applyCommand).toMatch(
      /^~\/\.local\/bin\/first-tree-staging --json context enable/u,
    );
  });

  it("rejects a concurrent grant add/remove before persistent mutation", async () => {
    const planId = await createPlanId();
    mocks.inspectStore.mockReturnValue({
      kind: "v3",
      config: { schemaVersion: 3, grants: [] },
      fingerprint: "c".repeat(64),
    });
    await expect(runContextEnable(context({ scope: "global", planId, yes: true }))).rejects.toMatchObject({
      code: "CONTEXT_ENABLE_PLAN_CHANGED",
    });
    expect(mocks.enableOperation).not.toHaveBeenCalled();
  });

  it("applies session-only without touching Plugin, Hook, or persistent grants", async () => {
    const planId = await createPlanId();
    output.result.mockClear();
    await runContextEnable(context({ scope: "session", planId, yes: true }));
    const result = output.result.mock.calls[0]?.[0] as { setup: { complete: boolean }; plugin: string };
    expect(result).toMatchObject({ setup: { complete: true }, plugin: "not_installed" });
    expect(mocks.assertFingerprint).toHaveBeenCalledWith("a".repeat(64));
    expect(mocks.issueSession).toHaveBeenCalledTimes(1);
    expect(mocks.createDriver).not.toHaveBeenCalled();
    expect(mocks.enableOperation).not.toHaveBeenCalled();
  });

  it("rejects an account switch while issuing a session-only receipt", async () => {
    const planId = await createPlanId();
    output.result.mockClear();
    mocks.issueSession.mockImplementationOnce(async () => {
      mocks.readAccount.mockReturnValue("client-2");
      return { receipt: "wrong-account-receipt" };
    });
    await expect(runContextEnable(context({ scope: "session", planId, yes: true }))).rejects.toMatchObject({
      code: "CONTEXT_ENABLE_PLAN_CHANGED",
    });
    expect(mocks.buildHandoff).not.toHaveBeenCalled();
    expect(output.result).not.toHaveBeenCalled();
  });

  it("never reports Complete or builds a handoff while Codex Hook trust is missing", async () => {
    const planId = await createPlanId();
    output.result.mockClear();
    mocks.inspectHook.mockResolvedValue({
      trust: "review_required",
      enabled: false,
      source: "provider_api",
      issues: [],
    });
    await runContextEnable(context({ scope: "global", planId, yes: true }));
    const result = output.result.mock.calls[0]?.[0] as {
      setup: { complete: boolean; missingLayers: string[] };
      currentSessionHandoff: unknown;
    };
    expect(result.setup.complete).toBe(false);
    expect(result.setup.missingLayers).toEqual(expect.arrayContaining(["Codex Hook requires review or trust."]));
    expect(result.currentSessionHandoff).toBeNull();
    expect(result).toMatchObject({ nextActions: [expect.stringContaining("/hooks")] });
    expect(mocks.buildHandoff).not.toHaveBeenCalled();
  });

  it("does not send a Plugin failure into the Codex Hook recovery loop", async () => {
    const planId = await createPlanId();
    output.result.mockClear();
    mocks.inspectRuntime.mockReturnValue({
      healthy: false,
      issues: ["payload digest mismatch"],
      probe: { installed: true, enabled: true, installedPath: "/plugin" },
      install: { marketplaceName: "first-tree", pluginName: "first-tree-context" },
    });
    mocks.inspectHook.mockResolvedValue({
      trust: "unknown",
      enabled: null,
      source: "unavailable",
      issues: ["Hook API unavailable"],
    });
    await runContextEnable(context({ scope: "global", planId, yes: true }));
    const result = output.result.mock.calls[0]?.[0] as {
      setup: { missingLayers: string[] };
      nextActions: string[];
    };
    expect(result.nextActions).toEqual([expect.stringContaining("Plugin")]);
    expect(result.nextActions.join("\n")).not.toContain("/hooks");
    expect(result.setup.missingLayers.join("\n")).not.toMatch(/not trusted|not enabled/iu);
  });

  it("reports unavailable Hook inspection without pretending consent is missing", async () => {
    const planId = await createPlanId();
    output.result.mockClear();
    mocks.inspectHook.mockResolvedValue({
      trust: "unknown",
      enabled: null,
      source: "unavailable",
      issues: ["Hook API timed out"],
    });
    await runContextEnable(context({ scope: "global", planId, yes: true }));
    const result = output.result.mock.calls[0]?.[0] as {
      setup: { complete: boolean; missingLayers: string[] };
      currentSessionHandoff: unknown;
      nextActions: string[];
    };
    expect(result.setup.complete).toBe(false);
    expect(result.currentSessionHandoff).toBeNull();
    expect(result.setup.missingLayers).toEqual(["Codex Hook inspection: Hook API timed out"]);
    expect(result.nextActions).toEqual([expect.stringContaining("Hook inspection/provider API availability")]);
    expect(result.nextActions.join("\n")).not.toContain("/hooks");
    expect(result.setup.missingLayers.join("\n")).not.toMatch(/not trusted|not enabled/iu);
  });

  it("rejects an account switch while waiting for Codex Hook verification", async () => {
    const planId = await createPlanId();
    output.result.mockClear();
    mocks.inspectHook.mockImplementationOnce(async () => {
      mocks.readAccount.mockReturnValue("client-2");
      return { trust: "trusted", enabled: true, source: "provider_api", issues: [] };
    });
    await expect(runContextEnable(context({ scope: "global", planId, yes: true }))).rejects.toMatchObject({
      code: "CONTEXT_ENABLE_PLAN_CHANGED",
    });
    expect(mocks.buildHandoff).not.toHaveBeenCalled();
    expect(output.result).not.toHaveBeenCalled();
  });

  it("accepts the same exact target grant after Codex Trust as an idempotent retry", async () => {
    const planId = await createPlanId();
    mocks.inspectStore.mockReturnValue({
      kind: "v3",
      config: {
        schemaVersion: 3,
        grants: [{ provider: "codex", organizationId: "org-a", activationScope: { kind: "global" } }],
      },
      fingerprint: "b".repeat(64),
    });
    output.result.mockClear();
    await runContextEnable(context({ scope: "global", planId, yes: true }));
    expect(mocks.enableOperation).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ organizationId: "org-a", activationScope: { kind: "global" } }),
      { beforeFingerprint: "a".repeat(64), afterFingerprint: "b".repeat(64) },
      "client-1",
    );
    expect(output.result.mock.calls[0]?.[0]).toMatchObject({
      setup: { complete: true },
      currentSessionHandoff: expect.objectContaining({ consumerKind: "byo" }),
    });
  });

  it("fails closed when final Team authority drifts after the displayed plan", async () => {
    const planId = await createPlanId();
    mocks.validateActivation
      .mockResolvedValueOnce({ schemaVersion: 2, outcome: "connected", team })
      .mockResolvedValueOnce({
        schemaVersion: 2,
        outcome: "connected",
        team: { organizationId: "org-b", displayName: "Team B", role: "member" },
      });
    output.result.mockClear();
    mocks.buildHandoff.mockClear();
    await runContextEnable(context({ scope: "global", planId, yes: true }));
    expect(output.result.mock.calls[0]?.[0]).toMatchObject({
      team,
      setup: { complete: false },
      currentSessionHandoff: null,
      nextActions: [expect.stringContaining("Team membership/binding authority")],
    });
    expect(JSON.stringify(output.result.mock.calls[0]?.[0])).not.toContain("/hooks");
    expect(mocks.buildHandoff).not.toHaveBeenCalled();
  });
});

async function createPlanId(): Promise<string> {
  output.result.mockClear();
  await runContextEnable(context({ plan: true }));
  return (output.result.mock.calls[0]?.[0] as { plan: { planId: string } }).plan.planId;
}

function context(options: Record<string, unknown>): CommandContext {
  return {
    command: {
      opts: () => ({ provider: "codex", team: "org-a", projectRoot: "/work/repo", ...options }),
    } as unknown as Command,
    options: { json: true, debug: false, quiet: false },
  };
}
