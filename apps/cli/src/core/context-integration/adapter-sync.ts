import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ContextIntegrationProvider } from "@first-tree/shared";
import { defaultHome } from "@first-tree/shared/config";
import semver from "semver";
import { channelConfig } from "../channel.js";
import {
  assertContextMutationCanStart,
  readActiveContextAccountClientId,
  withAccountStateMutationLock,
} from "./account-state-guard.js";
import { inspectContextAdapterNextSessionObligation } from "./adapter-observation.js";
import { assertContextAdapterPayloadHealthy } from "./adapter-payload-health.js";
import { planContextIntegrationInstall } from "./installer.js";
import { readContextIntegrationInstallManifest } from "./manifest.js";
import { repairContextIntegrationOperation } from "./operation.js";
import type { ContextIntegrationProviderDriver } from "./provider-driver.js";
import { createContextIntegrationProviderDriver } from "./provider-factory.js";
import { resolveContextIntegrationRelease } from "./release.js";

const SYNC_TTL_MS = 10 * 60 * 1000;
const COMPATIBLE_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

type AdapterSyncReceipt = {
  schemaVersion: 1;
  accountClientId: string;
  channel: "prod" | "staging" | "dev";
  provider: ContextIntegrationProvider;
  sessionId: string;
  challenge: string;
  fromAdapterVersion: string;
  fromAdapterDigest: string;
  targetAdapterVersion: string;
  targetAdapterDigest: string;
  expiresAt: string;
};

type CompatibleAdapterSession = {
  schemaVersion: 1;
  accountClientId: string;
  channel: "prod" | "staging" | "dev";
  provider: "claude-code";
  sessionIdHash: string;
  adapterVersion: string;
  adapterDigest: string;
  targetAdapterVersion: string;
  targetAdapterDigest: string;
  expiresAt: string;
};

export type AdapterSyncAction = {
  code: "adapter_sync_required";
  command: string;
  challenge: string;
};

export function issueAdapterSyncAction(
  input: {
    provider: ContextIntegrationProvider;
    sessionId: string;
    suppliedAdapterDigest: string;
  },
  options: { releaseRoot?: string; coreRoot?: string; driver?: ContextIntegrationProviderDriver } = {},
): AdapterSyncAction {
  assertSessionId(input.sessionId);
  const accountClientId = readActiveContextAccountClientId();
  const installed = readContextIntegrationInstallManifest(input.provider);
  const release = resolveContextIntegrationRelease(options.releaseRoot, { coreRoot: options.coreRoot });
  const target = release.manifest.providers[input.provider];
  if (
    !installed?.adapterVersion ||
    installed.loaderProtocolVersion !== 1 ||
    installed.channel !== channelConfig.channel ||
    installed.adapterDigest !== input.suppliedAdapterDigest
  ) {
    throw new AdapterSyncRejectedError(
      "The installed First Tree Context state cannot be safely updated automatically. Run an explicit Context repair.",
    );
  }
  try {
    assertContextAdapterPayloadHealthy(options.driver ?? createContextIntegrationProviderDriver(input.provider), {
      adapterVersion: installed.adapterVersion,
      adapterDigest: installed.adapterDigest,
    });
  } catch (error) {
    throw new AdapterSyncRejectedError(
      `The installed First Tree Context payload is not healthy enough for automatic update: ${message(error)}`,
    );
  }
  if (!semver.valid(installed.adapterVersion) || !semver.valid(target.adapterVersion)) {
    throw new AdapterSyncRejectedError(
      "The First Tree Context adapter version is invalid; explicit repair is required.",
    );
  }
  if (semver.gte(installed.adapterVersion, target.adapterVersion)) {
    throw new AdapterSyncRejectedError(
      semver.gt(installed.adapterVersion, target.adapterVersion)
        ? "The installed First Tree Context adapter is newer than this CLI; automatic downgrade is refused."
        : "The installed First Tree Context adapter bytes do not match this CLI; explicit repair is required.",
    );
  }
  const challenge = randomBytes(24).toString("hex");
  const receipt: AdapterSyncReceipt = {
    schemaVersion: 1,
    accountClientId,
    channel: channelConfig.channel,
    provider: input.provider,
    sessionId: input.sessionId,
    challenge,
    fromAdapterVersion: installed.adapterVersion,
    fromAdapterDigest: installed.adapterDigest,
    targetAdapterVersion: target.adapterVersion,
    targetAdapterDigest: target.adapterDigest,
    expiresAt: new Date(Date.now() + SYNC_TTL_MS).toISOString(),
  };
  if (input.provider === "claude-code") prepareCompatibleAdapterSession(receipt);
  writeReceipt(receipt);
  return {
    code: "adapter_sync_required",
    challenge,
    command: `${channelConfig.binName} --json context adapter-sync --provider ${input.provider} --challenge ${challenge}`,
  };
}

export function synchronizeContextAdapter(
  driver: ContextIntegrationProviderDriver,
  challenge: string,
  dependencies: {
    releaseRoot?: string;
    coreRoot?: string;
    planInstall?: typeof planContextIntegrationInstall;
    repairOperation?: typeof repairContextIntegrationOperation;
  } = {},
): {
  updated: true;
  provider: ContextIntegrationProvider;
  currentSessionAdoption: "next_session";
} {
  return withAccountStateMutationLock(() => {
    assertContextMutationCanStart();
    const receipt = readReceipt(driver.provider, challenge);
    const accountClientId = readActiveContextAccountClientId();
    const release = resolveContextIntegrationRelease(dependencies.releaseRoot, { coreRoot: dependencies.coreRoot });
    const installed = readContextIntegrationInstallManifest(driver.provider);
    const target = release.manifest.providers[driver.provider];
    if (driver.provider === "claude-code" && inspectContextAdapterNextSessionObligation() !== null) {
      throw new AdapterNextSessionRequiredError();
    }
    if (
      receipt.accountClientId === accountClientId &&
      receipt.channel === channelConfig.channel &&
      receipt.provider === driver.provider &&
      receipt.targetAdapterVersion === target.adapterVersion &&
      receipt.targetAdapterDigest === target.adapterDigest &&
      installed?.adapterVersion === target.adapterVersion &&
      installed.adapterDigest === target.adapterDigest
    ) {
      assertSynchronizedPayloadHealthy(driver, {
        adapterVersion: target.adapterVersion,
        adapterDigest: target.adapterDigest,
      });
      if (driver.provider === "claude-code") prepareCompatibleAdapterSession(receipt);
      rmSync(receiptPath(driver.provider, challenge), { force: true });
      return {
        updated: true as const,
        provider: driver.provider,
        currentSessionAdoption: "next_session" as const,
      };
    }
    if (
      receipt.accountClientId !== accountClientId ||
      receipt.channel !== channelConfig.channel ||
      receipt.provider !== driver.provider ||
      Date.parse(receipt.expiresAt) <= Date.now() ||
      !installed ||
      installed.adapterVersion !== receipt.fromAdapterVersion ||
      installed.adapterDigest !== receipt.fromAdapterDigest ||
      target.adapterVersion !== receipt.targetAdapterVersion ||
      target.adapterDigest !== receipt.targetAdapterDigest ||
      !semver.valid(receipt.fromAdapterVersion) ||
      !semver.valid(receipt.targetAdapterVersion) ||
      !semver.lt(receipt.fromAdapterVersion, receipt.targetAdapterVersion)
    ) {
      throw new AdapterSyncRejectedError(
        "First Tree Context changed after the automatic update action was issued. Run an explicit Context repair.",
      );
    }
    const concurrentClaudeReceipts =
      driver.provider === "claude-code" ? collectMatchingClaudeSyncReceipts(receipt) : [];
    const plan = (dependencies.planInstall ?? planContextIntegrationInstall)(driver, {
      releaseRoot: dependencies.releaseRoot,
    });
    if (
      plan.operation !== "repair" ||
      plan.previous?.adapterVersion !== receipt.fromAdapterVersion ||
      plan.previous.adapterDigest !== receipt.fromAdapterDigest ||
      plan.release.manifest.providers[driver.provider].adapterVersion !== receipt.targetAdapterVersion ||
      plan.release.manifest.providers[driver.provider].adapterDigest !== receipt.targetAdapterDigest
    ) {
      throw new AdapterSyncRejectedError("The exact automatic update plan no longer matches local Plugin state.");
    }
    if (driver.provider === "claude-code") {
      // These prepared facts are inert while the old install remains current
      // and become valid only after the exact target payload is healthy. Write
      // every concurrent session before provider mutation so a crash cannot
      // strand an already-loaded compatible adapter without recoverable proof.
      for (const compatibleReceipt of concurrentClaudeReceipts) {
        prepareCompatibleAdapterSession(compatibleReceipt);
      }
    }
    assertReceiptAccountAndTargetStillCurrent(receipt, release.manifest.providers[driver.provider]);
    (dependencies.repairOperation ?? repairContextIntegrationOperation)(driver, plan, {});
    assertReceiptAccountAndTargetStillCurrent(receipt, release.manifest.providers[driver.provider]);
    if (driver.provider === "claude-code") {
      for (const compatibleReceipt of concurrentClaudeReceipts) {
        if (compatibleReceipt.challenge !== receipt.challenge) writeReceipt(compatibleReceipt);
      }
    }
    rmSync(receiptPath(driver.provider, challenge), { force: true });
    return {
      updated: true as const,
      provider: driver.provider,
      currentSessionAdoption: "next_session" as const,
    };
  });
}

function assertSynchronizedPayloadHealthy(
  driver: ContextIntegrationProviderDriver,
  installed: { adapterVersion: string; adapterDigest: string },
): void {
  try {
    assertContextAdapterPayloadHealthy(driver, installed);
  } catch (error) {
    throw new AdapterSyncRejectedError(`The synchronized First Tree Context payload is not healthy: ${message(error)}`);
  }
}

function collectMatchingClaudeSyncReceipts(current: AdapterSyncReceipt): AdapterSyncReceipt[] {
  const root = adapterSyncRoot("claude-code");
  let receiptNames: string[];
  try {
    receiptNames = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^([0-9a-f]{48})\.json$/u.test(entry.name))
      .map((entry) => entry.name);
  } catch (error) {
    if (isMissing(error)) return [current];
    throw new AdapterSyncRejectedError(
      `The concurrent Claude Context update actions could not be inspected safely: ${message(error)}`,
    );
  }
  const receipts = new Map<string, AdapterSyncReceipt>([[current.challenge, current]]);
  for (const receiptName of receiptNames) {
    const challenge = receiptName.slice(0, -5);
    try {
      const candidate = readReceipt("claude-code", challenge);
      if (
        candidate.accountClientId === current.accountClientId &&
        candidate.channel === current.channel &&
        candidate.provider === current.provider &&
        candidate.fromAdapterVersion === current.fromAdapterVersion &&
        candidate.fromAdapterDigest === current.fromAdapterDigest &&
        candidate.targetAdapterVersion === current.targetAdapterVersion &&
        candidate.targetAdapterDigest === current.targetAdapterDigest
      ) {
        receipts.set(candidate.challenge, candidate);
      }
    } catch {
      // Invalid, expired, or unrelated actions are not restored across the global Plugin update.
    }
  }
  return [...receipts.values()];
}

export function hasKnownCompatibleContextAdapterSession(
  input: {
    provider: ContextIntegrationProvider;
    sessionId?: string;
    suppliedAdapterDigest: string;
  },
  options: { releaseRoot?: string; coreRoot?: string; driver?: ContextIntegrationProviderDriver } = {},
): boolean {
  if (input.provider !== "claude-code" || !input.sessionId || inspectContextAdapterNextSessionObligation() !== null) {
    return false;
  }
  try {
    assertSessionId(input.sessionId);
    const marker = readCompatibleAdapterSession(input.sessionId);
    if (!marker) return false;
    const release = resolveContextIntegrationRelease(options.releaseRoot, { coreRoot: options.coreRoot });
    const target = release.manifest.providers["claude-code"];
    const installed = readContextIntegrationInstallManifest("claude-code");
    if (
      marker.accountClientId !== readActiveContextAccountClientId() ||
      marker.channel !== channelConfig.channel ||
      marker.sessionIdHash !== sessionIdHash(input.sessionId) ||
      marker.adapterDigest !== input.suppliedAdapterDigest ||
      marker.targetAdapterVersion !== target.adapterVersion ||
      marker.targetAdapterDigest !== target.adapterDigest ||
      installed?.adapterVersion !== target.adapterVersion ||
      installed.adapterDigest !== target.adapterDigest ||
      !semver.valid(marker.adapterVersion) ||
      !semver.valid(marker.targetAdapterVersion) ||
      !semver.lt(marker.adapterVersion, marker.targetAdapterVersion)
    ) {
      return false;
    }
    assertContextAdapterPayloadHealthy(options.driver ?? createContextIntegrationProviderDriver("claude-code"), {
      adapterVersion: installed.adapterVersion,
      adapterDigest: installed.adapterDigest,
    });
    return true;
  } catch {
    return false;
  }
}

function assertReceiptAccountAndTargetStillCurrent(
  receipt: AdapterSyncReceipt,
  target: { adapterVersion: string; adapterDigest: string },
): void {
  const installed = readContextIntegrationInstallManifest(receipt.provider);
  if (
    readActiveContextAccountClientId() !== receipt.accountClientId ||
    target.adapterVersion !== receipt.targetAdapterVersion ||
    target.adapterDigest !== receipt.targetAdapterDigest ||
    (installed !== null &&
      installed.adapterVersion !== receipt.fromAdapterVersion &&
      (installed.adapterVersion !== receipt.targetAdapterVersion ||
        installed.adapterDigest !== receipt.targetAdapterDigest))
  ) {
    throw new AdapterSyncRejectedError("The active account or Context update target changed during adapter sync.");
  }
}

export function hasKnownGoodCompatibleContextAdapter(driver: ContextIntegrationProviderDriver): boolean {
  try {
    if (driver.provider === "claude-code" && inspectContextAdapterNextSessionObligation() !== null) return false;
    const installed = readContextIntegrationInstallManifest(driver.provider);
    if (
      installed?.channel !== channelConfig.channel ||
      installed.loaderProtocolVersion !== 1 ||
      !installed.adapterVersion ||
      !semver.valid(installed.adapterVersion)
    ) {
      return false;
    }
    assertContextAdapterPayloadHealthy(driver, {
      adapterVersion: installed.adapterVersion,
      adapterDigest: installed.adapterDigest,
    });
    return true;
  } catch {
    return false;
  }
}

export class AdapterNextSessionRequiredError extends Error {
  readonly code = "CONTEXT_PLUGIN_RELOAD_REQUIRED";

  constructor() {
    super("This Claude session cannot use the repaired First Tree Context Plugin. Start a new Claude session.");
    this.name = "AdapterNextSessionRequiredError";
  }
}

export class AdapterSyncRejectedError extends Error {
  readonly code = "CONTEXT_ADAPTER_SYNC_REJECTED";

  constructor(message: string) {
    super(message);
    this.name = "AdapterSyncRejectedError";
  }
}

function writeReceipt(receipt: AdapterSyncReceipt): void {
  const path = receiptPath(receipt.provider, receipt.challenge);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readReceipt(provider: ContextIntegrationProvider, challenge: string): AdapterSyncReceipt {
  if (!/^[0-9a-f]{48}$/u.test(challenge)) throw new AdapterSyncRejectedError("Invalid Context update action.");
  const primaryPath = receiptPath(provider, challenge);
  try {
    let serialized: string;
    try {
      serialized = readFileSync(primaryPath, "utf8");
    } catch (error) {
      if (!isMissing(error) || provider !== "claude-code") throw error;
      serialized = readFileSync(receiptBackupPath(challenge), "utf8");
    }
    const value = JSON.parse(serialized) as Partial<AdapterSyncReceipt>;
    if (
      value.schemaVersion !== 1 ||
      value.provider !== provider ||
      value.challenge !== challenge ||
      typeof value.sessionId !== "string" ||
      value.sessionId.length > 256 ||
      !/^[0-9A-Za-z._:-]+$/u.test(value.sessionId) ||
      typeof value.accountClientId !== "string" ||
      typeof value.fromAdapterVersion !== "string" ||
      typeof value.fromAdapterDigest !== "string" ||
      typeof value.targetAdapterVersion !== "string" ||
      typeof value.targetAdapterDigest !== "string" ||
      typeof value.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(value.expiresAt)) ||
      !["prod", "staging", "dev"].includes(value.channel ?? "")
    ) {
      throw new Error("invalid receipt");
    }
    if (Date.parse(value.expiresAt) <= Date.now()) {
      rmSync(primaryPath, { force: true });
      if (provider === "claude-code") rmSync(receiptBackupPath(challenge), { force: true });
      throw new AdapterSyncRejectedError("The automatic First Tree Context update action expired.");
    }
    return value as AdapterSyncReceipt;
  } catch (error) {
    if (error instanceof AdapterSyncRejectedError) throw error;
    throw new AdapterSyncRejectedError("The automatic First Tree Context update action is missing or invalid.");
  }
}

function prepareCompatibleAdapterSession(receipt: AdapterSyncReceipt): void {
  writeCompatibleAdapterSession(receipt);
  writeJson(receiptBackupPath(receipt.challenge), receipt);
}

function writeCompatibleAdapterSession(receipt: AdapterSyncReceipt): void {
  const marker: CompatibleAdapterSession = {
    schemaVersion: 1,
    accountClientId: receipt.accountClientId,
    channel: receipt.channel,
    provider: "claude-code",
    sessionIdHash: sessionIdHash(receipt.sessionId),
    adapterVersion: receipt.fromAdapterVersion,
    adapterDigest: receipt.fromAdapterDigest,
    targetAdapterVersion: receipt.targetAdapterVersion,
    targetAdapterDigest: receipt.targetAdapterDigest,
    expiresAt: new Date(Date.now() + COMPATIBLE_SESSION_TTL_MS).toISOString(),
  };
  writeJson(compatibleSessionPath(receipt.sessionId), marker);
}

function readCompatibleAdapterSession(sessionId: string): CompatibleAdapterSession | null {
  const path = compatibleSessionPath(sessionId);
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<CompatibleAdapterSession>;
    if (
      value.schemaVersion !== 1 ||
      value.provider !== "claude-code" ||
      typeof value.accountClientId !== "string" ||
      !["prod", "staging", "dev"].includes(value.channel ?? "") ||
      !/^sha256:[0-9a-f]{64}$/u.test(value.adapterDigest ?? "") ||
      !/^sha256:[0-9a-f]{64}$/u.test(value.targetAdapterDigest ?? "") ||
      !/^[0-9a-f]{64}$/u.test(value.sessionIdHash ?? "") ||
      typeof value.adapterVersion !== "string" ||
      typeof value.targetAdapterVersion !== "string" ||
      typeof value.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(value.expiresAt))
    ) {
      return null;
    }
    if (Date.parse(value.expiresAt) <= Date.now()) {
      rmSync(path, { force: true });
      return null;
    }
    return value as CompatibleAdapterSession;
  } catch {
    return null;
  }
}

function compatibleSessionPath(sessionId: string): string {
  return join(
    defaultHome(),
    "state",
    "context",
    "providers",
    "claude-code",
    "compatible-sessions",
    `${sessionIdHash(sessionId)}.json`,
  );
}

function receiptBackupPath(challenge: string): string {
  return join(
    defaultHome(),
    "state",
    "context",
    "providers",
    "claude-code",
    "compatible-sessions",
    "actions",
    `${challenge}.json`,
  );
}

function sessionIdHash(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function receiptPath(provider: ContextIntegrationProvider, challenge: string): string {
  return join(adapterSyncRoot(provider), `${challenge}.json`);
}

function adapterSyncRoot(provider: ContextIntegrationProvider): string {
  return join(defaultHome(), "state", "context", "providers", provider, "adapter-sync");
}

function assertSessionId(value: string): void {
  if (value.length > 256 || !/^[0-9A-Za-z._:-]+$/u.test(value)) {
    throw new AdapterSyncRejectedError("The provider session identity is invalid.");
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && Reflect.get(error, "code") === "ENOENT";
}
