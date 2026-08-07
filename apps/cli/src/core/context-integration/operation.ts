import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import {
  type ContextIntegrationConfig,
  type ContextIntegrationGrant,
  type ContextIntegrationInstallManifest,
  type ContextIntegrationProvider,
  type ContextPersistentActivationScope,
  contextIntegrationConfigSchema,
  contextIntegrationInstallManifestSchema,
  type LegacyContextIntegrationConfig,
  type LegacyV2ContextIntegrationConfig,
  legacyContextIntegrationConfigSchema,
  legacyV2ContextIntegrationConfigSchema,
} from "@first-tree/shared";
import { defaultHome } from "@first-tree/shared/config";
import { channelConfig } from "../channel.js";
import { readActiveContextAccountClientId } from "./account-state-guard.js";
import type { ContextAdapterNextSessionObligationKind } from "./adapter-observation.js";
import {
  assertContextIntegrationConfig,
  prepareContextGrantStoreForApply,
  preserveLegacyContextIntegrationBackup,
  readContextIntegrationConfig,
  removeContextGrants,
  replaceContextIntegrationConfig,
  withContextIntegrationLock,
  writeContextGrant,
} from "./context-binding-store.js";
import {
  type ContextIntegrationInstallPlan,
  clearContextIntegrationInstallJournal,
  contextIntegrationMarketplaceName,
  contextIntegrationMarketplaceSourcePath,
  installContextIntegration,
} from "./installer.js";
import {
  readContextIntegrationInstallManifest,
  removeContextIntegrationInstallManifest,
  writeContextIntegrationInstallManifest,
} from "./manifest.js";
import { contextPluginTreeDigest, verifyProviderInstalledContextPlugin } from "./payload-integrity.js";
import type { ContextIntegrationProviderDriver } from "./provider-driver.js";

type OperationSnapshot = {
  accountClientId: string;
  config: ContextIntegrationConfig;
  installManifest: ContextIntegrationInstallManifest | null;
  providerInstalled: boolean;
  providerEnabled: boolean;
  marketplaceSourceExisted: boolean;
  recoveryRoot: string;
  recoveryMarketplaceRoot: string | null;
  recoveryObservationRoot: string | null;
  recoveryObservationDigest: string | null;
};

type OperationJournal = {
  schemaVersion: 3;
  operationId: string;
  accountClientId: string;
  provider: ContextIntegrationProvider;
  operation: "enable" | "disable" | "repair";
  phase: "prepared" | "provider_changed" | "grant_changed" | "rollback_failed";
  previousConfig: ContextIntegrationConfig;
  previousInstallManifest: ContextIntegrationInstallManifest | null;
  providerInstalled: boolean;
  providerEnabled: boolean;
  marketplaceSourceExisted: boolean;
  recoveryMarketplaceRoot: string | null;
  recoveryObservationRoot: string | null;
  recoveryObservationDigest: string | null;
  startedAt: string;
};

type ParsedOperationJournal = OperationJournal & {
  legacyPreviousConfig: LegacyContextIntegrationConfig | LegacyV2ContextIntegrationConfig | null;
};

export function enableContextIntegrationOperation(
  driver: ContextIntegrationProviderDriver,
  plan: ContextIntegrationInstallPlan,
  grant: ContextIntegrationGrant,
  expectedStore: { beforeFingerprint: string; afterFingerprint: string },
  expectedAccountClientId: string,
  dependencies: {
    install?: typeof installContextIntegration;
    writeGrant?: typeof writeContextGrant;
    nextSessionObligationKind?: ContextAdapterNextSessionObligationKind;
  } = {},
): { pluginOperation: ContextIntegrationInstallPlan["operation"] } {
  return withContextIntegrationLock(() => {
    assertNoIncompleteOperation();
    assertExpectedAccount(expectedAccountClientId);
    const expectedConfig = prepareContextGrantStoreForApply(
      expectedStore.beforeFingerprint,
      expectedStore.afterFingerprint,
      grant,
    );
    const snapshot = captureOperationSnapshot(driver, expectedConfig);
    const journal = createOperationJournal("enable", driver, snapshot);
    let providerChanged = false;
    let grantChanged = false;
    try {
      if (plan.operation !== "unchanged") {
        providerChanged = true;
        (dependencies.install ?? installContextIntegration)(driver, plan, {
          nextSessionObligationKind: dependencies.nextSessionObligationKind,
        });
        writeOperationJournal({ ...journal, phase: "provider_changed" });
      }
      const result = (dependencies.writeGrant ?? writeContextGrant)(grant, { expectedConfig });
      grantChanged = result.created;
      writeOperationJournal({ ...journal, phase: "grant_changed" });
      completeOperation(snapshot);
      return { pluginOperation: plan.operation };
    } catch (error) {
      rollbackOperation(driver, snapshot, { providerChanged, grantChanged }, journal, error);
    }
  });
}

export function disableContextIntegrationOperation(
  provider: ContextIntegrationProvider,
  input: {
    organizationId: string;
    activationScope: ContextPersistentActivationScope;
    expectedConfig: ContextIntegrationConfig;
    expectedAccountClientId: string;
  },
  dependencies: { removeGrants?: typeof removeContextGrants } = {},
): { removed: ContextIntegrationGrant[]; remaining: ContextIntegrationGrant[] } {
  return withContextIntegrationLock(() => {
    assertNoIncompleteOperation();
    assertExpectedAccount(input.expectedAccountClientId);
    assertContextIntegrationConfig(input.expectedConfig);
    return (dependencies.removeGrants ?? removeContextGrants)(provider, {
      organizationId: input.organizationId,
      activationScope: input.activationScope,
      expectedConfig: input.expectedConfig,
    });
  });
}

export function repairContextIntegrationOperation(
  driver: ContextIntegrationProviderDriver,
  plan: ContextIntegrationInstallPlan,
  dependencies: {
    install?: typeof installContextIntegration;
    nextSessionObligationKind?: ContextAdapterNextSessionObligationKind;
  } = {},
): void {
  withContextIntegrationLock(() => {
    assertNoIncompleteOperation();
    const snapshot = captureOperationSnapshot(driver, readContextIntegrationConfig());
    const journal = createOperationJournal("repair", driver, snapshot);
    try {
      (dependencies.install ?? installContextIntegration)(driver, plan, {
        nextSessionObligationKind: dependencies.nextSessionObligationKind,
      });
      writeOperationJournal({ ...journal, phase: "provider_changed" });
      completeOperation(snapshot);
    } catch (error) {
      rollbackOperation(driver, snapshot, { providerChanged: true, grantChanged: false }, journal, error);
    }
  });
}

function captureOperationSnapshot(
  driver: ContextIntegrationProviderDriver,
  expectedConfig: ContextIntegrationConfig,
): OperationSnapshot {
  const accountClientId = readActiveContextAccountClientId();
  const installManifest = readContextIntegrationInstallManifest(driver.provider);
  const marketplaceName = installManifest?.marketplaceName ?? contextIntegrationMarketplaceName();
  const pluginName = installManifest?.pluginName ?? "first-tree-context";
  const probe = driver.probe(marketplaceName, pluginName);
  const operationId = randomUUID();
  const recoveryRoot = join(defaultHome(), "state", "context", "operation-recovery", operationId);
  const recoveryMarketplaceRoot = join(recoveryRoot, "marketplace");
  const recoveryObservationRoot = join(recoveryRoot, "observation");
  const stableMarketplaceRoot = contextIntegrationMarketplaceSourcePath(driver.provider);
  const marketplaceSourceExisted = existsSync(stableMarketplaceRoot);
  if (probe.installed && (!installManifest || !marketplaceSourceExisted)) {
    throw new Error(
      `The existing ${driver.provider} Context Plugin lacks a complete First Tree rollback source. Run \`${channelConfig.binName} context repair --provider ${driver.provider}\` before changing grants.`,
    );
  }
  if (probe.installed && !probe.enabled) {
    throw new Error(
      `The ${driver.provider} Context Plugin is installed but disabled. Enable it with the provider's native Plugin controls before changing grants; no state was changed.`,
    );
  }
  mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 });
  if (marketplaceSourceExisted) cpSync(stableMarketplaceRoot, recoveryMarketplaceRoot, { recursive: true });
  const recoveryObservationDigest = captureObservationState(driver.provider, recoveryObservationRoot);
  return {
    accountClientId,
    config: expectedConfig,
    installManifest,
    providerInstalled: probe.installed,
    providerEnabled: probe.enabled,
    marketplaceSourceExisted,
    recoveryRoot,
    recoveryMarketplaceRoot: marketplaceSourceExisted ? recoveryMarketplaceRoot : null,
    recoveryObservationRoot,
    recoveryObservationDigest,
  };
}

function createOperationJournal(
  operation: OperationJournal["operation"],
  driver: ContextIntegrationProviderDriver,
  snapshot: OperationSnapshot,
): OperationJournal {
  const journal: OperationJournal = {
    schemaVersion: 3,
    operationId: basename(snapshot.recoveryRoot),
    accountClientId: snapshot.accountClientId,
    provider: driver.provider,
    operation,
    phase: "prepared",
    previousConfig: snapshot.config,
    previousInstallManifest: snapshot.installManifest,
    providerInstalled: snapshot.providerInstalled,
    providerEnabled: snapshot.providerEnabled,
    marketplaceSourceExisted: snapshot.marketplaceSourceExisted,
    recoveryMarketplaceRoot: snapshot.recoveryMarketplaceRoot,
    recoveryObservationRoot: snapshot.recoveryObservationRoot,
    recoveryObservationDigest: snapshot.recoveryObservationDigest,
    startedAt: new Date().toISOString(),
  };
  writeOperationJournal(journal);
  return journal;
}

function rollbackOperation(
  driver: ContextIntegrationProviderDriver,
  snapshot: OperationSnapshot,
  changed: { providerChanged: boolean; grantChanged: boolean },
  journal: OperationJournal,
  originalError: unknown,
): never {
  const rollbackErrors: unknown[] = [];
  if (changed.providerChanged) {
    try {
      assertObservationSnapshotIntegrity(snapshot.recoveryObservationRoot, snapshot.recoveryObservationDigest);
    } catch (error) {
      writeOperationJournal({ ...journal, phase: "rollback_failed" });
      throw new AggregateError(
        [originalError, error],
        "First Tree Context operation failed and its observation recovery snapshot is incomplete. Preserve the recovery journal and run Context repair.",
      );
    }
  }
  if (changed.grantChanged || JSON.stringify(readContextIntegrationConfig()) !== JSON.stringify(snapshot.config)) {
    try {
      replaceContextIntegrationConfig(snapshot.config);
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  if (changed.providerChanged) {
    try {
      restoreProviderSnapshot(driver, snapshot);
      restoreObservationState(driver.provider, snapshot.recoveryObservationRoot);
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
  if (rollbackErrors.length > 0) {
    writeOperationJournal({ ...journal, phase: "rollback_failed" });
    throw new AggregateError(
      [originalError, ...rollbackErrors],
      `First Tree Context operation failed and could not fully restore Plugin, manifest, and grant state. Run \`${channelConfig.binName} context repair --provider ${driver.provider}\` before retrying.`,
    );
  }
  completeOperation(snapshot);
  throw originalError;
}

function restoreProviderSnapshot(driver: ContextIntegrationProviderDriver, snapshot: OperationSnapshot): void {
  const stableMarketplaceRoot = contextIntegrationMarketplaceSourcePath(driver.provider);
  if (snapshot.providerInstalled && snapshot.installManifest && snapshot.recoveryMarketplaceRoot) {
    rmSync(stableMarketplaceRoot, { recursive: true, force: true });
    mkdirSync(dirname(stableMarketplaceRoot), { recursive: true, mode: 0o700 });
    cpSync(snapshot.recoveryMarketplaceRoot, stableMarketplaceRoot, { recursive: true });
    const restoredProbe = driver.install({
      marketplaceRoot: stableMarketplaceRoot,
      marketplaceName: snapshot.installManifest.marketplaceName,
      pluginName: snapshot.installManifest.pluginName,
    });
    verifyProviderInstalledContextPlugin(
      restoredProbe,
      contextPluginTreeDigest(join(stableMarketplaceRoot, "plugins", snapshot.installManifest.pluginName)),
    );
    writeContextIntegrationInstallManifest(snapshot.installManifest);
  } else {
    const current = readContextIntegrationInstallManifest(driver.provider);
    driver.uninstall({
      marketplaceName:
        current?.marketplaceName ?? snapshot.installManifest?.marketplaceName ?? contextIntegrationMarketplaceName(),
      pluginName: current?.pluginName ?? snapshot.installManifest?.pluginName ?? "first-tree-context",
    });
    rmSync(stableMarketplaceRoot, { recursive: true, force: true });
    if (snapshot.marketplaceSourceExisted && snapshot.recoveryMarketplaceRoot) {
      mkdirSync(dirname(stableMarketplaceRoot), { recursive: true, mode: 0o700 });
      cpSync(snapshot.recoveryMarketplaceRoot, stableMarketplaceRoot, { recursive: true });
    }
    if (snapshot.installManifest) writeContextIntegrationInstallManifest(snapshot.installManifest);
    else removeContextIntegrationInstallManifest(driver.provider);
  }
  clearContextIntegrationInstallJournal();
}

function completeOperation(snapshot: OperationSnapshot): void {
  rmSync(operationJournalPath(), { force: true });
  rmSync(snapshot.recoveryRoot, { recursive: true, force: true });
}

export function recoverContextIntegrationOperation(driver: ContextIntegrationProviderDriver): boolean {
  return withContextIntegrationLock(() => {
    const journal = readOperationJournal();
    if (!journal) return false;
    if (journal.provider !== driver.provider) {
      throw new Error(`The incomplete Context operation belongs to ${journal.provider}. Run repair for it first.`);
    }
    const recoveryRoot = join(defaultHome(), "state", "context", "operation-recovery", journal.operationId);
    const expectedMarketplaceRoot = join(recoveryRoot, "marketplace");
    const expectedObservationRoot = join(recoveryRoot, "observation");
    if (journal.recoveryMarketplaceRoot !== null && journal.recoveryMarketplaceRoot !== expectedMarketplaceRoot) {
      throw new Error("The incomplete Context operation recovery path is invalid.");
    }
    if (journal.recoveryObservationRoot !== null && journal.recoveryObservationRoot !== expectedObservationRoot) {
      throw new Error("The incomplete Context observation recovery path is invalid.");
    }
    const snapshot: OperationSnapshot = {
      accountClientId: journal.accountClientId,
      config: journal.previousConfig,
      installManifest: journal.previousInstallManifest,
      providerInstalled: journal.providerInstalled,
      providerEnabled: journal.providerEnabled,
      marketplaceSourceExisted: journal.marketplaceSourceExisted,
      recoveryRoot,
      recoveryMarketplaceRoot: journal.recoveryMarketplaceRoot,
      recoveryObservationRoot: journal.recoveryObservationRoot,
      recoveryObservationDigest: journal.recoveryObservationDigest,
    };
    if (readActiveContextAccountClientId() !== snapshot.accountClientId) {
      throw new Error("The incomplete Context operation belongs to a different local Computer/account state.");
    }
    const errors: unknown[] = [];
    try {
      if (journal.legacyPreviousConfig) preserveLegacyContextIntegrationBackup(journal.legacyPreviousConfig);
      replaceContextIntegrationConfig(snapshot.config);
    } catch (error) {
      errors.push(error);
    }
    try {
      restoreProviderSnapshot(driver, snapshot);
      restoreObservationState(driver.provider, snapshot.recoveryObservationRoot);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Could not recover the incomplete First Tree Context operation.");
    }
    completeOperation(snapshot);
    return true;
  });
}

function operationJournalPath(): string {
  return join(defaultHome(), "state", "context", "operation-journal.json");
}

export function inspectContextIntegrationOperation(): Pick<
  OperationJournal,
  "operation" | "phase" | "provider"
> | null {
  const journal = readOperationJournal();
  return journal ? { provider: journal.provider, operation: journal.operation, phase: journal.phase } : null;
}

function readOperationJournal(): ParsedOperationJournal | null {
  try {
    const parsed = JSON.parse(readFileSync(operationJournalPath(), "utf8")) as Record<string, unknown>;
    const operationIdValid =
      typeof parsed.operationId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(parsed.operationId);
    if (
      (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2 && parsed.schemaVersion !== 3) ||
      !operationIdValid ||
      typeof parsed.accountClientId !== "string" ||
      !/^client_[a-f0-9]{8}$/u.test(parsed.accountClientId) ||
      (parsed.provider !== "claude-code" && parsed.provider !== "codex") ||
      (parsed.operation !== "enable" && parsed.operation !== "disable" && parsed.operation !== "repair") ||
      typeof parsed.providerInstalled !== "boolean" ||
      typeof parsed.providerEnabled !== "boolean" ||
      typeof parsed.marketplaceSourceExisted !== "boolean" ||
      (parsed.recoveryMarketplaceRoot !== null && typeof parsed.recoveryMarketplaceRoot !== "string") ||
      (parsed.schemaVersion === 3 && typeof parsed.recoveryObservationRoot !== "string") ||
      (parsed.schemaVersion === 3 && !/^sha256:[0-9a-f]{64}$/u.test(String(parsed.recoveryObservationDigest ?? ""))) ||
      typeof parsed.startedAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.startedAt))
    ) {
      throw new Error("invalid operation journal");
    }
    const phaseValid =
      parsed.schemaVersion === 2 || parsed.schemaVersion === 3
        ? ["prepared", "provider_changed", "grant_changed", "rollback_failed"].includes(String(parsed.phase))
        : ["prepared", "provider_changed", "binding_changed", "rollback_failed"].includes(String(parsed.phase));
    if (!phaseValid) throw new Error("invalid operation journal phase");
    const previousInstallManifest =
      parsed.previousInstallManifest === null
        ? null
        : contextIntegrationInstallManifestSchema.parse(parsed.previousInstallManifest);
    validateProviderRecoveryState(parsed, previousInstallManifest);
    if (parsed.schemaVersion === 2 || parsed.schemaVersion === 3) {
      assertCurrentOperationConfigShape(parsed.previousConfig);
      return {
        ...(parsed as Omit<OperationJournal, "previousConfig" | "previousInstallManifest">),
        schemaVersion: 3,
        previousConfig: contextIntegrationConfigSchema.parse(parsed.previousConfig),
        previousInstallManifest,
        recoveryObservationRoot: parsed.schemaVersion === 3 ? (parsed.recoveryObservationRoot as string) : null,
        recoveryObservationDigest: parsed.schemaVersion === 3 ? (parsed.recoveryObservationDigest as string) : null,
        legacyPreviousConfig: null,
      };
    }
    if (!Array.isArray(parsed.previousBindings)) throw new Error("operation journal previous bindings are missing");
    const legacyPreviousConfig = parseLegacyOperationConfig(parsed.previousBindings);
    return {
      schemaVersion: 3,
      operationId: parsed.operationId as string,
      accountClientId: parsed.accountClientId as string,
      provider: parsed.provider as ContextIntegrationProvider,
      operation: parsed.operation as OperationJournal["operation"],
      phase: parsed.phase === "binding_changed" ? "grant_changed" : (parsed.phase as OperationJournal["phase"]),
      previousConfig: { schemaVersion: 3, grants: [] },
      previousInstallManifest,
      providerInstalled: parsed.providerInstalled as boolean,
      providerEnabled: parsed.providerEnabled as boolean,
      marketplaceSourceExisted: parsed.marketplaceSourceExisted as boolean,
      recoveryMarketplaceRoot: parsed.recoveryMarketplaceRoot as string | null,
      recoveryObservationRoot: null,
      recoveryObservationDigest: null,
      startedAt: parsed.startedAt as string,
      legacyPreviousConfig,
    };
  } catch (error) {
    if (isMissing(error)) return null;
    throw new Error(`Invalid First Tree Context operation journal at ${operationJournalPath()}.`, { cause: error });
  }
}

function parseLegacyOperationConfig(
  previousBindings: unknown,
): LegacyContextIntegrationConfig | LegacyV2ContextIntegrationConfig {
  const v2 = legacyV2ContextIntegrationConfigSchema.safeParse({ schemaVersion: 2, bindings: previousBindings });
  if (v2.success) return v2.data;
  return legacyContextIntegrationConfigSchema.parse({ schemaVersion: 1, bindings: previousBindings });
}

function validateProviderRecoveryState(
  journal: Record<string, unknown>,
  previousInstallManifest: ContextIntegrationInstallManifest | null,
): void {
  const installed = journal.providerInstalled === true;
  const enabled = journal.providerEnabled === true;
  const sourceExisted = journal.marketplaceSourceExisted === true;
  const hasRecoveryRoot = typeof journal.recoveryMarketplaceRoot === "string";
  if (installed !== enabled) throw new Error("provider installed/enabled recovery state is inconsistent");
  if (sourceExisted !== hasRecoveryRoot) throw new Error("marketplace recovery state is inconsistent");
  if (installed && (!previousInstallManifest || !sourceExisted)) {
    throw new Error("installed provider recovery state is incomplete");
  }
  if (previousInstallManifest && previousInstallManifest.provider !== journal.provider) {
    throw new Error("operation journal manifest provider does not match the operation provider");
  }
  const recoveryRoot = join(defaultHome(), "state", "context", "operation-recovery", String(journal.operationId));
  const expectedMarketplaceRoot = join(recoveryRoot, "marketplace");
  const expectedObservationRoot = join(recoveryRoot, "observation");
  if (hasRecoveryRoot && journal.recoveryMarketplaceRoot !== expectedMarketplaceRoot) {
    throw new Error("operation recovery path is invalid");
  }
  if (
    journal.schemaVersion === 3 &&
    (journal.recoveryObservationRoot !== expectedObservationRoot || typeof journal.recoveryObservationRoot !== "string")
  ) {
    throw new Error("operation observation recovery path is invalid");
  }
  if (journal.schemaVersion === 3 && !/^sha256:[0-9a-f]{64}$/u.test(String(journal.recoveryObservationDigest ?? ""))) {
    throw new Error("operation observation recovery digest is invalid");
  }
  assertRecoveryDirectory(recoveryRoot, "operation recovery root");
  if (sourceExisted) {
    assertRecoveryDirectory(expectedMarketplaceRoot, "operation marketplace recovery source");
    const relativePath = relative(realpathSync(recoveryRoot), realpathSync(expectedMarketplaceRoot));
    if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error("operation marketplace recovery source escapes the operation recovery root");
    }
  }
  if (journal.schemaVersion === 3) {
    assertRecoveryDirectory(expectedObservationRoot, "operation observation recovery source");
    const relativePath = relative(realpathSync(recoveryRoot), realpathSync(expectedObservationRoot));
    if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error("operation observation recovery source escapes the operation recovery root");
    }
    assertObservationSnapshotIntegrity(expectedObservationRoot, journal.recoveryObservationDigest as string);
  }
}

const OBSERVATION_STATE_ENTRIES = [
  "adapter-sync",
  // compatible-sessions contains exact-target-gated facts and action backups
  // issued independently of this provider operation. Restoring an earlier
  // operation snapshot must not erase actions issued while the operation ran.
  "reload-pending",
  "reload-consumed",
  "reload-required.json",
  "next-session-required.json",
] as const;

function captureObservationState(provider: ContextIntegrationProvider, recoveryRoot: string): string {
  mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 });
  const providerRoot = join(defaultHome(), "state", "context", "providers", provider);
  for (const entry of OBSERVATION_STATE_ENTRIES) {
    const source = join(providerRoot, entry);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(source);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    const expectedFile = entry === "reload-required.json" || entry === "next-session-required.json";
    if (stat.isSymbolicLink() || (expectedFile && !stat.isFile()) || (!expectedFile && !stat.isDirectory())) {
      throw new Error(`The Context observation state contains an invalid ${entry} entry.`);
    }
    cpSync(source, join(recoveryRoot, entry), { recursive: true });
  }
  return contextOperationObservationSnapshotDigest(recoveryRoot);
}

function restoreObservationState(provider: ContextIntegrationProvider, recoveryRoot: string | null): void {
  if (!recoveryRoot) return;
  const providerRoot = join(defaultHome(), "state", "context", "providers", provider);
  mkdirSync(providerRoot, { recursive: true, mode: 0o700 });
  for (const entry of OBSERVATION_STATE_ENTRIES) {
    const target = join(providerRoot, entry);
    rmSync(target, { recursive: true, force: true });
    const source = join(recoveryRoot, entry);
    if (existsSync(source)) cpSync(source, target, { recursive: true });
  }
}

function assertObservationSnapshotIntegrity(recoveryRoot: string | null, expectedDigest: string | null): void {
  if (recoveryRoot === null && expectedDigest === null) return;
  if (!recoveryRoot || !expectedDigest || contextOperationObservationSnapshotDigest(recoveryRoot) !== expectedDigest) {
    throw new Error("The Context observation recovery snapshot is incomplete or has changed.");
  }
}

export function contextOperationObservationSnapshotDigest(root: string): string {
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("The Context observation recovery snapshot root must be a real directory.");
  }
  const hash = createHash("sha256");
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      const relativePath = relative(root, path).split("\\").join("/");
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("The Context observation recovery snapshot contains a symlink.");
      if (stat.isDirectory()) {
        hash.update("directory\0");
        hash.update(relativePath);
        hash.update("\0");
        visit(path);
      } else if (stat.isFile()) {
        hash.update("file\0");
        hash.update(relativePath);
        hash.update("\0");
        hash.update(readFileSync(path));
        hash.update("\0");
      } else {
        throw new Error("The Context observation recovery snapshot contains an unsupported entry.");
      }
    }
  };
  visit(root);
  return `sha256:${hash.digest("hex")}`;
}

function assertCurrentOperationConfigShape(value: unknown): void {
  if (
    typeof value !== "object" ||
    value === null ||
    Reflect.get(value, "schemaVersion") !== 3 ||
    !Array.isArray(Reflect.get(value, "grants"))
  ) {
    throw new Error("operation journal previous grant snapshot is incomplete");
  }
}

function assertRecoveryDirectory(path: string, label: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new Error(`${label} is missing or unreadable`, { cause: error });
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a non-symlink directory`);
}

function assertNoIncompleteOperation(): void {
  const incomplete = inspectContextIntegrationOperation();
  if (incomplete) {
    throw new Error(
      `A First Tree Context Plugin/grant operation is incomplete. Run \`${channelConfig.binName} context repair --provider ${incomplete.provider}\` before retrying.`,
    );
  }
}

function assertExpectedAccount(expectedAccountClientId: string): void {
  if (readActiveContextAccountClientId() !== expectedAccountClientId) {
    throw new Error("The active First Tree Computer/account changed after the displayed Context plan. Re-run it.");
  }
}

function writeOperationJournal(journal: OperationJournal): void {
  const path = operationJournalPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && Reflect.get(error, "code") === "ENOENT";
}
