import { createHash } from "node:crypto";
import type { ContextActivationScope, ContextIntegrationGrant, ContextIntegrationProvider } from "@first-tree/shared";
import { confirm } from "@inquirer/prompts";
import type { Command } from "commander";
import {
  readActiveContextAccountClientId,
  withAccountStateMutationLockAsync,
} from "../../core/context-integration/account-state-guard.js";
import {
  ContextReloadReceiptError,
  consumeContextAdapterReloadReceipt,
  consumeContextAdapterReloadRequiredMarker,
  hasContextAdapterReloadRequiredMarker,
  hasPendingContextAdapterReload,
  registerPendingContextAdapterReload,
} from "../../core/context-integration/adapter-observation.js";
import { inspectContextSetupLocation } from "../../core/context-integration/client-preflight.js";
import {
  assertContextGrantStoreFingerprint,
  contextGrantStoreFingerprintAfterGrant,
  inspectContextGrantStore,
  readContextIntegrationConfig,
} from "../../core/context-integration/context-binding-store.js";
import {
  buildCurrentSessionHandoff,
  type CurrentSessionHandoff,
} from "../../core/context-integration/current-session-handoff.js";
import { planContextIntegrationInstall } from "../../core/context-integration/installer.js";
import { enableContextIntegrationOperation } from "../../core/context-integration/operation.js";
import { providerPluginRoot, resolveContextIntegrationRelease } from "../../core/context-integration/release.js";
import { inspectContextIntegrationRuntime } from "../../core/context-integration/runtime-health.js";
import { buildContextSetupChoices, type ContextSetupChoice } from "../../core/context-integration/setup-plan.js";
import { print } from "../../core/output.js";
import { createMemberSdk } from "../_shared/member.js";
import type { CommandContext, SubcommandModule } from "../types.js";
import { createContextIntegrationDriver, parseContextProvider } from "./shared.js";

type EnableOptions = {
  provider?: string;
  team?: string;
  plan?: boolean;
  scope?: string;
  planId?: string;
  yes?: boolean;
  projectRoot?: string;
  pathless?: boolean;
  reloadReceipt?: string;
};

const setupPlanAccountClientId = Symbol("setupPlanAccountClientId");

type SetupPlan = {
  schemaVersion: 1;
  planId: string;
  grantStoreFingerprint: string;
  provider: ContextIntegrationProvider;
  team: { organizationId: string; displayName: string; role: string };
  location: ReturnType<typeof inspectContextSetupLocation>;
  choices: ContextSetupChoice[];
  [setupPlanAccountClientId]: string;
};

type SetupPlanToken = {
  identityFingerprint: string;
  beforeFingerprint: string;
  globalAfterFingerprint: string;
  directoryAfterFingerprint: string | null;
  planChallenge: string;
};

function configure(command: Command): void {
  command
    .requiredOption("--provider <provider>", "claude-code or codex")
    .requiredOption("--team <team-id>", "Team from the server-authored Setup handoff")
    .option(
      "--plan",
      "inspect the provider location and return the available activation choices without mutating state",
    )
    .option("--scope <scope>", "apply global, directory, or session activation")
    .option("--plan-id <plan-id>", "exact plan id returned by --plan")
    .option("--project-root <directory>", "explicit provider directory")
    .option("--pathless", "provider session without a usable directory")
    .option("--reload-receipt <receipt>", "opaque Claude session-loaded receipt")
    .option("--yes", "accept the selected activation change");
}

export async function runContextEnable(context: CommandContext): Promise<void> {
  const options = context.command.opts<EnableOptions>();
  const provider = parseContextProvider(options.provider ?? "");
  const teamId = options.team?.trim() ?? "";
  if (!teamId) print.fail("CONTEXT_TEAM_REQUIRED", "--team must contain the server-authored Team id.", 2);

  const plan = await buildSetupPlan(provider, teamId, options);
  if (options.plan || !options.scope) {
    renderPlan(plan, context.options.json);
    return;
  }
  const activationScope = parseActivationScope(options.scope, plan);
  const submittedPlan = parseSetupPlanToken(options.planId ?? "");
  const currentToken = parseSetupPlanToken(plan.planId);
  const expectedAfterFingerprint =
    activationScope.kind === "global"
      ? submittedPlan?.globalAfterFingerprint
      : activationScope.kind === "directory"
        ? submittedPlan?.directoryAfterFingerprint
        : null;
  const storeMatches =
    submittedPlan !== null &&
    (plan.grantStoreFingerprint === submittedPlan.beforeFingerprint ||
      (activationScope.kind !== "session" &&
        expectedAfterFingerprint !== null &&
        plan.grantStoreFingerprint === expectedAfterFingerprint));
  if (
    !submittedPlan ||
    !currentToken ||
    submittedPlan.identityFingerprint !== currentToken.identityFingerprint ||
    !storeMatches
  ) {
    print.fail(
      "CONTEXT_ENABLE_PLAN_CHANGED",
      "The setup location, account, provider, or Team changed after the displayed choice. Run --plan again and ask the user again.",
      2,
    );
  }
  const acceptedPlan = submittedPlan as SetupPlanToken;
  const accepted =
    options.yes === true ||
    (!context.options.json &&
      (await confirm({ message: `Apply ${activationScope.kind} First Tree activation?`, default: true })));
  if (!accepted) print.fail("CONTEXT_ENABLE_CANCELLED", "No changes were applied.", 2);

  const result =
    activationScope.kind === "session"
      ? await applySessionOnly(provider, plan, activationScope, acceptedPlan.beforeFingerprint)
      : await applyPersistent(
          provider,
          plan,
          activationScope,
          {
            beforeFingerprint: acceptedPlan.beforeFingerprint,
            afterFingerprint: requireAfterFingerprint(expectedAfterFingerprint),
          },
          acceptedPlan.planChallenge,
          options.reloadReceipt,
        );
  if (context.options.json) {
    print.result(result);
    return;
  }
  print.status("Provider", provider);
  print.status("Team", `${plan.team.displayName} (${plan.team.organizationId})`);
  print.status("Activation scope", renderScope(activationScope));
  print.status(
    "Persistent Plugin",
    activationScope.kind === "session" ? "Not installed for this choice" : result.plugin,
  );
  print.status("Current-session handoff", result.currentSessionHandoff ? "Ready" : "Unavailable");
  print.line(`\nSetup: ${result.setup.complete ? "Complete" : "Incomplete"}\n`);
  if (result.currentSessionHandoff) {
    print.line(`${JSON.stringify(result.currentSessionHandoff, null, 2)}\n`);
  }
  result.nextActions.forEach((action, index) => {
    print.status(`Next ${index + 1}`, action);
  });
}

async function buildSetupPlan(
  provider: ContextIntegrationProvider,
  teamId: string,
  options: EnableOptions,
): Promise<SetupPlan> {
  const location = inspectContextSetupLocation(provider, {
    projectRoot: options.projectRoot,
    pathless: options.pathless,
  });
  const accountClientId = readActiveContextAccountClientId();
  const sdk = createMemberSdk();
  const activation = await sdk.validateMemberContextActivation(
    teamId,
    { schemaVersion: 2 },
    { retry: false, timeoutMs: 2_000 },
  );
  if (activation.outcome !== "connected") {
    print.fail(activation.reasonCode, activation.nextAction.message, 1);
  }
  // Verify the exact immutable Core root during planning. Every apply rebuilds
  // this plan, so an unusable loader is rejected before setup mutates state or
  // returns a handoff that cannot load its canonical workflow.
  resolvePinnedContextCoreRelease();
  const planIdentity = {
    schemaVersion: 1,
    provider,
    teamId: activation.team.organizationId,
    accountClientId,
    project: location.project,
    directory: location.directory,
    directoryAvailable: location.directoryAvailable,
    temporaryDirectory: location.temporaryDirectory,
  };
  const grantStore = inspectContextGrantStore();
  const globalGrant: ContextIntegrationGrant = {
    provider,
    organizationId: activation.team.organizationId,
    activationScope: { kind: "global" },
  };
  const directoryGrant: ContextIntegrationGrant | null =
    location.directoryAvailable && location.directory
      ? {
          provider,
          organizationId: activation.team.organizationId,
          activationScope: { kind: "directory", root: location.directory },
        }
      : null;
  const tokenWithoutChallenge = {
    identityFingerprint: createHash("sha256").update(JSON.stringify(planIdentity)).digest("hex"),
    beforeFingerprint: grantStore.fingerprint,
    globalAfterFingerprint: contextGrantStoreFingerprintAfterGrant(grantStore, globalGrant),
    directoryAfterFingerprint: directoryGrant
      ? contextGrantStoreFingerprintAfterGrant(grantStore, directoryGrant)
      : null,
  };
  const token: SetupPlanToken = {
    ...tokenWithoutChallenge,
    planChallenge: computePlanChallenge(tokenWithoutChallenge),
  };
  const planId = renderSetupPlanToken(token);
  return {
    schemaVersion: 1,
    planId,
    grantStoreFingerprint: grantStore.fingerprint,
    provider,
    team: activation.team,
    location,
    choices: buildContextSetupChoices(location, {
      provider,
      teamId: activation.team.organizationId,
      planId,
    }),
    [setupPlanAccountClientId]: accountClientId,
  };
}

function parseActivationScope(scope: string, plan: SetupPlan): ContextActivationScope {
  if (scope === "global") return { kind: "global" };
  if (scope === "session") return { kind: "session" };
  if (scope === "directory") {
    if (!plan.location.directoryAvailable || !plan.location.directory) {
      print.fail("CONTEXT_DIRECTORY_UNAVAILABLE", "Directory activation is unavailable for this session.", 2);
      throw new Error("unreachable");
    }
    const root = plan.location.directory;
    return { kind: "directory", root };
  }
  print.fail("CONTEXT_SCOPE_INVALID", "--scope must be global, directory, or session.", 2);
  throw new Error("unreachable");
}

async function applySessionOnly(
  provider: ContextIntegrationProvider,
  plan: SetupPlan,
  activationScope: Extract<ContextActivationScope, { kind: "session" }>,
  expectedGrantStoreFingerprint: string,
) {
  return withAccountStateMutationLockAsync(async () => {
    assertPlannedAccount(plan);
    assertContextGrantStoreFingerprint(expectedGrantStoreFingerprint);
    const finalActivation = await validateExactTeam(plan);
    const release = resolvePinnedContextCoreRelease();
    const sessionCandidate = await createMemberSdk().issueMemberContextSessionCandidate(
      {
        schemaVersion: 1,
        provider,
        project: plan.location.project,
        organizationId: plan.team.organizationId,
      },
      { retry: false, timeoutMs: 5_000 },
    );
    assertPlannedAccount(plan);
    const handoff = buildCurrentSessionHandoff({
      provider,
      project: plan.location.project,
      activationScope,
      organizationId: plan.team.organizationId,
      sessionCandidateReceipt: sessionCandidate.receipt,
      pluginRoot: providerPluginRoot(release.root, provider),
    });
    assertPlannedAccount(plan);
    return {
      provider,
      team: finalActivation.team,
      project: plan.location.project,
      activationScope,
      plugin: "not_installed" as const,
      setup: { complete: true, missingLayers: [] as string[] },
      currentSessionHandoff: handoff,
      nextActions: ["Adopt the verified handoff in this session. It will not auto-activate in a future session."],
    };
  });
}

function resolvePinnedContextCoreRelease() {
  try {
    return resolveContextIntegrationRelease(undefined, { requirePinnedCoreRoot: true });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      Reflect.get(error, "code") === "CONTEXT_SKILL_RELEASE_ROOT_UNTRUSTED"
    ) {
      print.fail("CONTEXT_SKILL_RELEASE_ROOT_UNTRUSTED", error instanceof Error ? error.message : String(error), 2, {
        nextActions: ["Install or use a version-pinned First Tree CLI release, then retry Context setup."],
      });
    }
    throw error;
  }
}

async function applyPersistent(
  provider: ContextIntegrationProvider,
  plan: SetupPlan,
  activationScope: Exclude<ContextActivationScope, { kind: "session" }>,
  expectedStore: { beforeFingerprint: string; afterFingerprint: string },
  planChallenge: string,
  reloadReceipt: string | undefined,
) {
  return withAccountStateMutationLockAsync(async () => {
    assertPlannedAccount(plan);
    const driver = createContextIntegrationDriver(provider);
    const installPlan = planContextIntegrationInstall(driver);
    const grant: ContextIntegrationGrant = {
      provider,
      organizationId: plan.team.organizationId,
      activationScope,
    };
    enableContextIntegrationOperation(driver, installPlan, grant, expectedStore, plan[setupPlanAccountClientId], {
      reloadObligationKind: provider === "claude-code" && installPlan.operation !== "unchanged" ? "setup" : undefined,
    });
    const health = inspectContextIntegrationRuntime(driver);
    const grantReady = readContextIntegrationConfig().grants.some(
      (candidate) =>
        candidate.provider === provider &&
        candidate.organizationId === plan.team.organizationId &&
        JSON.stringify(candidate.activationScope) === JSON.stringify(activationScope),
    );
    const hook = await driver.inspectHook({
      marketplaceName: health.install?.marketplaceName ?? "first-tree",
      pluginName: health.install?.pluginName ?? "first-tree-context",
      plugin: { installed: health.probe.installed, enabled: health.probe.enabled },
      cwd: plan.location.directory ?? process.cwd(),
    });
    const hookRequired = provider === "codex";
    const hookInspectionUnavailable =
      hookRequired && (hook.source === "unavailable" || hook.trust === "unknown" || hook.enabled === null);
    const hookConsentRequired =
      hookRequired &&
      !hookInspectionUnavailable &&
      (hook.trust === "review_required" || hook.trust === "modified" || hook.enabled === false);
    const finalActivation = await validateExactTeam(plan).catch((error: unknown) => ({
      outcome: "unavailable" as const,
      message: error instanceof Error ? error.message : String(error),
    }));
    assertPlannedAccount(plan);
    const pluginMissing = !health.healthy;
    let claudeReloadRequired = false;
    if (provider === "claude-code" && health.release !== null) {
      const durableSetupMarker =
        installPlan.operation !== "unchanged" ||
        hasContextAdapterReloadRequiredMarker(health.release.manifest, "setup");
      if (durableSetupMarker) {
        registerPendingContextAdapterReload(planChallenge, health.release.manifest);
        // Pending is durable before the setup marker is removed. A
        // crash can therefore leave duplicate obligations, never no
        // obligation. The next exact apply safely repeats this conversion.
        consumeContextAdapterReloadRequiredMarker(health.release.manifest, "setup");
        claudeReloadRequired = true;
      } else if (hasPendingContextAdapterReload(planChallenge, health.release.manifest)) {
        if (reloadReceipt) {
          try {
            consumeContextAdapterReloadReceipt({
              planChallenge,
              receipt: reloadReceipt,
              release: health.release.manifest,
            });
          } catch (error) {
            if (error instanceof ContextReloadReceiptError) {
              print.fail(error.code, error.message, 2, {
                nextActions: [
                  "Run /reload-plugins, reply Continue in this Claude session, then retry the original exact apply.",
                ],
              });
            }
            throw error;
          }
        } else {
          claudeReloadRequired = true;
        }
      } else if (reloadReceipt) {
        print.fail(
          "CONTEXT_RELOAD_RECEIPT_INVALID",
          "This Claude reload proof does not belong to a pending exact setup plan.",
          2,
        );
      }
    }
    const authorityMissing = finalActivation.outcome !== "connected";
    const missingLayers = [
      ...(pluginMissing ? health.issues.map((issue) => `Plugin: ${issue}`) : []),
      ...(claudeReloadRequired ? ["Claude Code must reload and observe the thin Context Plugin."] : []),
      ...(grantReady ? [] : ["Activation grant was not found after apply."]),
      ...(hookInspectionUnavailable
        ? hook.issues.length > 0
          ? hook.issues.map((issue) => `Codex Hook inspection: ${issue}`)
          : ["Codex Hook state could not be inspected."]
        : []),
      ...(!hookInspectionUnavailable && hookRequired && hook.trust !== "trusted"
        ? ["Codex Hook requires review or trust."]
        : []),
      ...(!hookInspectionUnavailable && hookRequired && hook.enabled !== true ? ["Codex Hook is not enabled."] : []),
      ...(authorityMissing ? [`Team authority: ${finalActivation.message}`] : []),
    ];
    let currentSessionHandoff: CurrentSessionHandoff | null = null;
    if (missingLayers.length === 0 && health.probe.installedPath) {
      currentSessionHandoff = buildCurrentSessionHandoff({
        provider,
        project: plan.location.project,
        activationScope,
        organizationId: plan.team.organizationId,
        pluginRoot: health.probe.installedPath,
      });
    }
    assertPlannedAccount(plan);
    const setupComplete = missingLayers.length === 0 && currentSessionHandoff !== null;
    const nextActions = setupComplete
      ? ["Adopt the verified handoff in this session. Future sessions will load the neutral Team router automatically."]
      : [
          ...(pluginMissing ? ["Repair the reported Plugin payload/state, then rerun the exact apply command."] : []),
          ...(grantReady
            ? []
            : [
                "Rerun the exact apply command to restore the missing activation grant; do not use /hooks for this error.",
              ]),
          ...(authorityMissing
            ? ["Restore the reported Team membership/binding authority, create a fresh plan, and ask the user again."]
            : []),
          ...(!pluginMissing && claudeReloadRequired
            ? [
                "Run /reload-plugins in Claude Code, reply Continue, then rerun the original exact apply with the opaque reload receipt supplied by the new Plugin.",
              ]
            : []),
          ...(!pluginMissing && hookInspectionUnavailable
            ? ["Restore Codex Hook inspection/provider API availability, then rerun the exact apply command."]
            : []),
          ...(!pluginMissing && hookConsentRequired
            ? [
                "Open /hooks, Enable and Trust First Tree Context, return here, and say Continue so the same apply command runs again.",
              ]
            : []),
        ];
    return {
      provider,
      team: finalActivation.outcome === "connected" ? finalActivation.team : plan.team,
      project: plan.location.project,
      activationScope,
      plugin: installPlan.operation,
      setup: { complete: setupComplete, missingLayers },
      currentSessionHandoff,
      nextActions,
    };
  });
}

function assertPlannedAccount(plan: SetupPlan): void {
  if (readActiveContextAccountClientId() === plan[setupPlanAccountClientId]) return;
  print.fail(
    "CONTEXT_ENABLE_PLAN_CHANGED",
    "The active First Tree Computer/account changed while applying this setup. Create a fresh plan and ask the user again.",
    2,
  );
}

async function validateExactTeam(plan: SetupPlan): Promise<{ outcome: "connected"; team: SetupPlan["team"] }> {
  const activation = await createMemberSdk().validateMemberContextActivation(
    plan.team.organizationId,
    { schemaVersion: 2 },
    { retry: false, timeoutMs: 2_000 },
  );
  if (activation.outcome !== "connected" || activation.team.organizationId !== plan.team.organizationId) {
    const reason =
      activation.outcome === "connected"
        ? "The final Team identity did not match the setup plan."
        : activation.nextAction.message;
    throw new Error(`Final Team activation changed after the setup plan: ${reason}`);
  }
  return activation;
}

function renderPlan(plan: SetupPlan, json: boolean): void {
  if (json) {
    print.result({ status: "choice_required", plan });
    return;
  }
  print.status("Provider", plan.provider);
  print.status("Team", `${plan.team.displayName} (${plan.team.organizationId})`);
  print.status("Current directory", plan.location.directory ?? "Unavailable");
  if (plan.location.warning) print.status("Warning", plan.location.warning);
  for (const choice of plan.choices) {
    print.status(choice.label, choice.available ? choice.description : `Unavailable — ${choice.description}`);
    if (choice.applyCommand) print.status("Apply command", choice.applyCommand);
  }
  print.status("Next", "Choose one scope, then run its exact apply command unchanged.");
}

function renderScope(scope: ContextActivationScope): string {
  return scope.kind === "directory" ? `directory (${scope.root})` : scope.kind;
}

function renderSetupPlanToken(token: SetupPlanToken): string {
  return [
    "v2",
    token.identityFingerprint,
    token.beforeFingerprint,
    token.globalAfterFingerprint,
    token.directoryAfterFingerprint ?? "-",
    token.planChallenge,
  ].join(".");
}

function parseSetupPlanToken(value: string): SetupPlanToken | null {
  const [version, identityFingerprint, beforeFingerprint, globalAfterFingerprint, directoryAfter, planChallenge] =
    value.split(".");
  const digest = /^[0-9a-f]{64}$/u;
  if (
    version !== "v2" ||
    !identityFingerprint ||
    !beforeFingerprint ||
    !globalAfterFingerprint ||
    !digest.test(identityFingerprint) ||
    !digest.test(beforeFingerprint) ||
    !digest.test(globalAfterFingerprint) ||
    (directoryAfter !== "-" && (!directoryAfter || !digest.test(directoryAfter))) ||
    !planChallenge ||
    !digest.test(planChallenge) ||
    planChallenge !==
      computePlanChallenge({
        identityFingerprint,
        beforeFingerprint,
        globalAfterFingerprint,
        directoryAfterFingerprint: directoryAfter === "-" ? null : directoryAfter,
      })
  ) {
    return null;
  }
  return {
    identityFingerprint,
    beforeFingerprint,
    globalAfterFingerprint,
    directoryAfterFingerprint: directoryAfter === "-" ? null : directoryAfter,
    planChallenge,
  };
}

function computePlanChallenge(token: Omit<SetupPlanToken, "planChallenge">): string {
  return createHash("sha256")
    .update(JSON.stringify({ ...token, purpose: "reload" }))
    .digest("hex");
}

function requireAfterFingerprint(value: string | null | undefined): string {
  if (value) return value;
  print.fail("CONTEXT_ENABLE_PLAN_CHANGED", "The selected scope was not present in the displayed plan.", 2);
  throw new Error("unreachable");
}

export const contextEnableCommand: SubcommandModule = {
  name: "enable",
  alias: "",
  summary: "",
  description: "Plan or apply a Team-specific BYO Context activation scope.",
  configure,
  action: runContextEnable,
};
