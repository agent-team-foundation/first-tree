import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  contextIntegrationConfigSchema,
  contextIntegrationInstallJournalSchema,
  contextIntegrationInstallManifestSchema,
  contextIntegrationProviderSchema,
  legacyContextIntegrationConfigSchema,
  legacyV2ContextIntegrationConfigSchema,
} from "@first-tree/shared";
import { defaultHome, readConfigFile } from "@first-tree/shared/config";
import { contextRepairCommand } from "./repair-guidance.js";

const heldAccountLocks = new Set<string>();

export class AccountStateMutationBusyError extends Error {
  constructor(options?: ErrorOptions) {
    super("Another First Tree account or Context state change is already running.", options);
    this.name = "AccountStateMutationBusyError";
  }
}

export function withAccountStateMutationLock<T>(action: () => T, home = defaultHome()): T {
  const release = acquireAccountStateMutationLock(home);
  try {
    return action();
  } finally {
    release();
  }
}

export async function withAccountStateMutationLockAsync<T>(action: () => Promise<T>, home = defaultHome()): Promise<T> {
  const release = acquireAccountStateMutationLock(home);
  try {
    return await action();
  } finally {
    release();
  }
}

export function assertContextMutationCanStart(home = defaultHome()): void {
  if (
    existsSync(join(home, "state", "client-switch.lock")) ||
    existsSync(join(home, "state", "client-switch-journal.json"))
  ) {
    throw new Error(
      "A First Tree client account switch is active or incomplete. Finish that login recovery before changing or recovering Context Plugin/binding state.",
    );
  }
}

export function assertClientSwitchCanStart(home = defaultHome()): void {
  const installJournal = join(home, "state", "context", "install-journal.json");
  const operationJournal = join(home, "state", "context", "operation-journal.json");
  for (const journal of [operationJournal, installJournal]) {
    if (!existsSync(journal)) continue;
    const provider = readBlockingJournalProvider(journal);
    throw new Error(
      `A First Tree Context Plugin/binding operation is incomplete. Run \`${contextRepairCommand(provider)}\` before switching accounts.`,
    );
  }
  if (existsSync(join(home, "state", "context", "install.lock"))) {
    throw new Error(
      "A First Tree Context Plugin/binding operation is still active. Wait for it to finish before switching accounts.",
    );
  }
  const byoState = join(home, "state", "context", "byo");
  if (existsSync(byoState)) {
    for (const organizationId of readdirSync(byoState)) {
      const organizationState = join(byoState, organizationId);
      const mutationLock = join(organizationState, "mutation.lock");
      if (existsSync(mutationLock)) {
        removeStalePidLock(mutationLock);
        if (existsSync(mutationLock)) {
          throw new Error("A BYO Context Tree repository mutation is active. Wait for it before switching accounts.");
        }
      }
      if (existsSync(join(organizationState, "rebind-journal.json"))) {
        throw new Error("A BYO Context Tree repository rebind is incomplete. Recover it before switching accounts.");
      }
      const writes = join(organizationState, "writes");
      if (existsSync(writes) && readdirSync(writes).some((entry) => entry.endsWith(".json"))) {
        throw new Error("A BYO Context Tree write is active. Finish or recover it before switching accounts.");
      }
    }
  }
  const byoData = join(home, "data", "byo");
  if (existsSync(byoData)) {
    for (const organizationId of readdirSync(byoData)) {
      const worktrees = join(byoData, organizationId, "worktrees");
      if (existsSync(worktrees) && readdirSync(worktrees).length > 0) {
        throw new Error("A BYO Context Tree worktree is active. Finish or recover it before switching accounts.");
      }
    }
  }
}

export function readActiveContextAccountClientId(home = defaultHome()): string {
  const raw = readConfigFile(join(home, "config", "client.yaml"));
  const client = raw.client;
  const id = typeof client === "object" && client !== null ? (client as { id?: unknown }).id : null;
  if (typeof id !== "string" || !/^client_[a-f0-9]{8}$/u.test(id)) {
    throw new Error("First Tree Context requires the active logged-in Computer identity before mutating local state.");
  }
  return id;
}

function acquireAccountStateMutationLock(home: string): () => void {
  const path = join(home, "state", "account-state.lock");
  if (heldAccountLocks.has(path)) return () => undefined;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  removeStalePidLock(path);
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch (error) {
    if (errorCode(error) === "EEXIST") throw new AccountStateMutationBusyError({ cause: error });
    throw error;
  }
  heldAccountLocks.add(path);
  writeFileSync(descriptor, `${process.pid}\n`, "utf8");
  return () => {
    heldAccountLocks.delete(path);
    closeSync(descriptor);
    rmSync(path, { force: true });
  };
}

function removeStalePidLock(path: string): void {
  try {
    const owner = Number(readFileSync(path, "utf8").trim());
    if (!Number.isInteger(owner) || owner <= 0) return;
    try {
      process.kill(owner, 0);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? Reflect.get(error, "code") : undefined;
      if (code === "ESRCH") rmSync(path, { force: true });
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? Reflect.get(error, "code") : undefined;
}

function readBlockingJournalProvider(path: string) {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (path.endsWith("install-journal.json")) {
      return contextIntegrationInstallJournalSchema.parse(value).provider;
    }
    if (typeof value !== "object" || value === null) throw new Error("invalid operation journal");
    const journal = value as Record<string, unknown>;
    const provider = contextIntegrationProviderSchema.parse(journal.provider);
    const operationIdValid =
      typeof journal.operationId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(journal.operationId);
    const previousConfig = journal.previousConfig;
    const currentConfigShapeValid =
      typeof previousConfig === "object" &&
      previousConfig !== null &&
      Reflect.get(previousConfig, "schemaVersion") === 3 &&
      Array.isArray(Reflect.get(previousConfig, "grants"));
    const legacyBindingsShapeValid = Array.isArray(journal.previousBindings);
    const configValid =
      ((journal.schemaVersion === 2 || journal.schemaVersion === 3) &&
        currentConfigShapeValid &&
        contextIntegrationConfigSchema.safeParse(previousConfig).success) ||
      (journal.schemaVersion === 1 &&
        legacyBindingsShapeValid &&
        (legacyV2ContextIntegrationConfigSchema.safeParse({ schemaVersion: 2, bindings: journal.previousBindings })
          .success ||
          legacyContextIntegrationConfigSchema.safeParse({ schemaVersion: 1, bindings: journal.previousBindings })
            .success));
    const manifestValid =
      journal.previousInstallManifest === null ||
      contextIntegrationInstallManifestSchema.safeParse(journal.previousInstallManifest).success;
    if (
      ![1, 2, 3].includes(Number(journal.schemaVersion)) ||
      !operationIdValid ||
      typeof journal.accountClientId !== "string" ||
      !/^client_[a-f0-9]{8}$/u.test(journal.accountClientId) ||
      !["enable", "disable", "repair"].includes(String(journal.operation)) ||
      !["prepared", "provider_changed", "binding_changed", "grant_changed", "rollback_failed"].includes(
        String(journal.phase),
      ) ||
      !configValid ||
      !manifestValid ||
      typeof journal.providerInstalled !== "boolean" ||
      typeof journal.providerEnabled !== "boolean" ||
      typeof journal.marketplaceSourceExisted !== "boolean" ||
      (journal.recoveryMarketplaceRoot !== null && typeof journal.recoveryMarketplaceRoot !== "string") ||
      (journal.schemaVersion === 3 &&
        journal.recoveryObservationRoot !==
          join(dirname(path), "operation-recovery", String(journal.operationId), "observation")) ||
      (journal.schemaVersion === 3 &&
        !/^sha256:[0-9a-f]{64}$/u.test(String(journal.recoveryObservationDigest ?? ""))) ||
      typeof journal.startedAt !== "string" ||
      !Number.isFinite(Date.parse(journal.startedAt)) ||
      journal.providerInstalled !== journal.providerEnabled ||
      journal.marketplaceSourceExisted !== (typeof journal.recoveryMarketplaceRoot === "string") ||
      (journal.providerInstalled === true &&
        (journal.previousInstallManifest === null || journal.marketplaceSourceExisted !== true)) ||
      (typeof journal.recoveryMarketplaceRoot === "string" &&
        journal.recoveryMarketplaceRoot !==
          join(dirname(path), "operation-recovery", String(journal.operationId), "marketplace"))
    ) {
      throw new Error("invalid operation journal");
    }
    return provider;
  } catch (error) {
    throw new Error(
      `The incomplete Context operation journal at ${path} is unreadable or invalid. Preserve the file and repair the journal before switching accounts.`,
      { cause: error },
    );
  }
}
