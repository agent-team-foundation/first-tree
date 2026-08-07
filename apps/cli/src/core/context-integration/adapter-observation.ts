import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ContextIntegrationProvider, ContextIntegrationReleaseManifest } from "@first-tree/shared";
import { defaultHome } from "@first-tree/shared/config";
import semver from "semver";
import { channelConfig } from "../channel.js";
import { readActiveContextAccountClientId, withAccountStateMutationLock } from "./account-state-guard.js";
import { assertContextAdapterPayloadHealthy } from "./adapter-payload-health.js";
import { readContextIntegrationInstallManifest } from "./manifest.js";
import type { ContextIntegrationProviderDriver } from "./provider-driver.js";
import { createContextIntegrationProviderDriver } from "./provider-factory.js";
import { resolveContextIntegrationRelease } from "./release.js";

export type ContextAdapterNextSessionObligationKind = "setup" | "standalone_repair";

type NextSessionRequiredMarker = {
  schemaVersion: 1;
  accountClientId: string;
  provider: "claude-code";
  adapterVersion: string;
  adapterDigest: string;
  kind: ContextAdapterNextSessionObligationKind;
  createdAt: string;
};

export function beginContextAdapterNextSessionObligation(
  release: ContextIntegrationReleaseManifest,
  kind: ContextAdapterNextSessionObligationKind,
): () => void {
  const path = nextSessionRequiredPath();
  let previous: string | null = null;
  try {
    previous = readFileSync(path, "utf8");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  writeNextSessionRequiredMarker(release, kind);
  return () => {
    if (previous === null) {
      rmSync(path, { force: true });
      return;
    }
    writeRaw(path, previous);
  };
}

export function inspectContextAdapterNextSessionObligation(): ContextAdapterNextSessionObligationKind | null {
  return readNextSessionRequiredMarker()?.kind ?? null;
}

/** A fresh Claude startup from the current deterministic adapter is the adoption boundary. */
export function consumeContextAdapterNextSessionObligation(
  input: {
    provider: ContextIntegrationProvider;
    adapterDigest: string;
    sessionStartSource?: string;
  },
  options: { releaseRoot?: string; coreRoot?: string } = {},
): ContextAdapterNextSessionObligationKind | null {
  if (input.provider !== "claude-code" || input.sessionStartSource !== "startup") return null;
  return withAccountStateMutationLock(() => {
    const release = resolveContextIntegrationRelease(options.releaseRoot, { coreRoot: options.coreRoot });
    const install = readContextIntegrationInstallManifest("claude-code");
    const target = release.manifest.providers["claude-code"];
    if (
      !install?.adapterVersion ||
      input.adapterDigest !== install.adapterDigest ||
      install.adapterVersion !== target.adapterVersion ||
      install.adapterDigest !== target.adapterDigest
    ) {
      return null;
    }
    const required = readNextSessionRequiredMarker();
    if (!required) return null;
    if (required.adapterVersion !== target.adapterVersion || required.adapterDigest !== target.adapterDigest) {
      return null;
    }
    rmSync(nextSessionRequiredPath(), { force: true });
    return required.kind;
  });
}

export function clearContextAdapterObservation(
  provider: ContextIntegrationProvider,
  options: { includeNextSessionRequired?: boolean; includeCompatibleSessions?: boolean } = {},
): void {
  const root = providerStateRoot(provider);
  rmSync(join(root, "adapter-sync"), { recursive: true, force: true });
  // Retire the former same-session reload proof state whenever a deterministic
  // adapter is installed. It is never consulted by the next-session contract.
  rmSync(join(root, "reload-pending"), { recursive: true, force: true });
  rmSync(join(root, "reload-consumed"), { recursive: true, force: true });
  rmSync(join(root, "reload-required.json"), { force: true });
  if (provider === "claude-code" && options.includeNextSessionRequired) {
    rmSync(nextSessionRequiredPath(), { force: true });
  }
  if (provider === "claude-code" && options.includeCompatibleSessions) {
    rmSync(join(root, "compatible-sessions"), { recursive: true, force: true });
  }
}

export function assertContextAdapterReadyForRouting(
  provider: ContextIntegrationProvider,
  options: { releaseRoot?: string; coreRoot?: string; driver?: ContextIntegrationProviderDriver } = {},
): void {
  const release = resolveContextIntegrationRelease(options.releaseRoot, { coreRoot: options.coreRoot });
  const expected = release.manifest.providers[provider];
  const install = readContextIntegrationInstallManifest(provider);
  if (provider === "claude-code" && readNextSessionRequiredMarker()) {
    throw new ContextPluginReloadRequiredError(
      "This Claude session has not adopted the repaired First Tree Context Plugin. Start a new session, then retry.",
    );
  }
  const exact = install?.adapterVersion === expected.adapterVersion && install.adapterDigest === expected.adapterDigest;
  const compatibleLoadedAdapter =
    install?.channel === channelConfig.channel &&
    install.loaderProtocolVersion === 1 &&
    Boolean(
      install.adapterVersion &&
        semver.valid(install.adapterVersion) &&
        semver.valid(expected.adapterVersion) &&
        semver.lt(install.adapterVersion, expected.adapterVersion),
    );
  if (!exact && !compatibleLoadedAdapter) {
    throw new ContextPluginReloadRequiredError();
  }
  if (!install?.adapterVersion || !install.adapterDigest) throw new ContextPluginReloadRequiredError();
  try {
    assertContextAdapterPayloadHealthy(options.driver ?? createContextIntegrationProviderDriver(provider), {
      adapterVersion: install.adapterVersion,
      adapterDigest: install.adapterDigest,
    });
  } catch (error) {
    throw new ContextPluginReloadRequiredError("The installed First Tree Context Plugin payload has drifted.", {
      cause: error,
    });
  }
}

export class ContextPluginReloadRequiredError extends Error {
  readonly code = "CONTEXT_PLUGIN_RELOAD_REQUIRED";

  constructor(
    message = "This provider session is not using a compatible First Tree Context Plugin. Repair the Plugin or start a new session, then retry.",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ContextPluginReloadRequiredError";
  }
}

export class ContextNextSessionRecoveryStateError extends Error {
  readonly code = "CONTEXT_NEXT_SESSION_RECOVERY_STATE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ContextNextSessionRecoveryStateError";
  }
}

function writeNextSessionRequiredMarker(
  release: ContextIntegrationReleaseManifest,
  kind: ContextAdapterNextSessionObligationKind,
): void {
  const target = release.providers["claude-code"];
  const marker: NextSessionRequiredMarker = {
    schemaVersion: 1,
    accountClientId: readActiveContextAccountClientId(),
    provider: "claude-code",
    adapterVersion: target.adapterVersion,
    adapterDigest: target.adapterDigest,
    kind,
    createdAt: new Date().toISOString(),
  };
  writeJson(nextSessionRequiredPath(), marker);
}

function readNextSessionRequiredMarker(): NextSessionRequiredMarker | null {
  try {
    const value = JSON.parse(readFileSync(nextSessionRequiredPath(), "utf8")) as Partial<NextSessionRequiredMarker>;
    if (
      value.schemaVersion !== 1 ||
      value.provider !== "claude-code" ||
      typeof value.accountClientId !== "string" ||
      typeof value.adapterVersion !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(value.adapterDigest ?? "") ||
      (value.kind !== "setup" && value.kind !== "standalone_repair") ||
      typeof value.createdAt !== "string" ||
      !Number.isFinite(Date.parse(value.createdAt))
    ) {
      throw new Error("invalid next-session marker");
    }
    if (value.accountClientId !== readActiveContextAccountClientId()) {
      throw new Error("next-session marker belongs to another account");
    }
    return value as NextSessionRequiredMarker;
  } catch (error) {
    if (isMissing(error)) return null;
    throw new ContextNextSessionRecoveryStateError("The pending Claude next-session state is unreadable or invalid.");
  }
}

function providerStateRoot(provider: ContextIntegrationProvider): string {
  return join(defaultHome(), "state", "context", "providers", provider);
}

function nextSessionRequiredPath(): string {
  return join(providerStateRoot("claude-code"), "next-session-required.json");
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

function writeRaw(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(temporary, content, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && Reflect.get(error, "code") === "ENOENT";
}
