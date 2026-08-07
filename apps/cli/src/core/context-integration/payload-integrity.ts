import { createHash } from "node:crypto";
import { chmodSync, lstatSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { ContextIntegrationProvider } from "@first-tree/shared";
import { quotePosixShellArg } from "../posix-shell.js";
import { resolveCliInvocation } from "../supervisor/shared.js";
import type { ResolvedBinary } from "../supervisor/types.js";
import type { ProviderPluginProbe } from "./provider-driver.js";
import { type ContextIntegrationRelease, providerPluginRoot } from "./release.js";

const LAUNCHER_PATHS = ["bin/context-session-start"] as const;
const HOOK_PATH = "hooks/hooks.json";

export function materializeContextPluginPayload(
  pluginRoot: string,
  adapterDigest: string,
  invocation: ResolvedBinary = resolveCliInvocation(),
): string {
  const renderedInvocation = renderCliInvocation(invocation);
  for (const name of LAUNCHER_PATHS) {
    const launcherPath = join(pluginRoot, name);
    writeFileSync(launcherPath, materializedFile(name, readFileSync(launcherPath), adapterDigest, renderedInvocation), {
      mode: 0o700,
    });
    chmodSync(launcherPath, 0o700);
  }

  const hookPath = join(pluginRoot, HOOK_PATH);
  const temporary = `${hookPath}.tmp`;
  writeFileSync(temporary, materializedFile(HOOK_PATH, readFileSync(hookPath), adapterDigest, renderedInvocation), {
    mode: 0o600,
  });
  renameSync(temporary, hookPath);

  for (const skillPath of normalizedFiles(join(pluginRoot, "skills"))) {
    if (!skillPath.endsWith(".md")) continue;
    writeFileSync(
      skillPath,
      materializedFile(
        relative(pluginRoot, skillPath).split("\\").join("/"),
        readFileSync(skillPath),
        adapterDigest,
        renderedInvocation,
      ),
    );
  }
  return renderedInvocation;
}

/**
 * Proves that the stable, materialized Plugin source is exactly the current
 * embedded release after applying the two machine-specific substitutions.
 */
export function verifyMaterializedContextPlugin(
  pluginRoot: string,
  release: ContextIntegrationRelease,
  provider: ContextIntegrationProvider,
  renderedInvocation: string,
): string {
  assertLauncherExecutable(pluginRoot);
  const releaseRoot = providerPluginRoot(release.root, provider);
  const releaseFiles = normalizedFiles(releaseRoot);
  const materializedFiles = normalizedFiles(pluginRoot);
  const releaseNames = releaseFiles.map((path) => relative(releaseRoot, path).split("\\").join("/"));
  const materializedNames = materializedFiles.map((path) => relative(pluginRoot, path).split("\\").join("/"));
  if (JSON.stringify(materializedNames) !== JSON.stringify(releaseNames)) {
    throw new Error("The materialized Context Plugin file set does not match the current First Tree release.");
  }

  const adapterDigest = release.manifest.providers[provider].adapterDigest;
  for (let index = 0; index < releaseFiles.length; index += 1) {
    const name = releaseNames[index] ?? "";
    const expected = materializedFile(name, readFileSync(releaseFiles[index] ?? ""), adapterDigest, renderedInvocation);
    const actual = readFileSync(materializedFiles[index] ?? "");
    if (!actual.equals(expected)) {
      throw new Error(`The materialized Context Plugin payload differs from the current release at ${name}.`);
    }
  }
  return contextPluginTreeDigest(pluginRoot);
}

/**
 * Proves that the provider-owned cache contains the same complete payload that
 * First Tree just materialized and verified.
 */
export function verifyProviderInstalledContextPlugin(probe: ProviderPluginProbe, expectedDigest: string): void {
  if (!probe.installedPath) {
    throw new Error("The provider did not expose a verifiable installed Context Plugin path.");
  }
  assertLauncherExecutable(probe.installedPath);
  const actualDigest = contextPluginTreeDigest(probe.installedPath);
  if (actualDigest !== expectedDigest) {
    throw new Error("The provider-installed Context Plugin payload does not match the current First Tree release.");
  }
}

export function inspectContextPluginPayload(
  probe: ProviderPluginProbe,
  stablePluginRoot: string,
  release: ContextIntegrationRelease,
  provider: ContextIntegrationProvider,
  renderedInvocation: string | undefined,
): string[] {
  if (!probe.installed || !probe.enabled) return [];
  if (!renderedInvocation) {
    return ["The Context Plugin install manifest does not record its materialized CLI invocation."];
  }
  try {
    verifyStableAdapterMarketplace(stablePluginRoot, release, provider);
    const expectedDigest = verifyMaterializedContextPlugin(stablePluginRoot, release, provider, renderedInvocation);
    verifyProviderInstalledContextPlugin(probe, expectedDigest);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

function verifyStableAdapterMarketplace(
  stablePluginRoot: string,
  release: ContextIntegrationRelease,
  provider: ContextIntegrationProvider,
): void {
  const stableRoot = dirname(dirname(stablePluginRoot));
  const releaseRoot = join(release.root, provider);
  const pluginPrefix = "plugins/first-tree-context/";
  const releaseFiles = normalizedFiles(releaseRoot).filter(
    (path) => !relative(releaseRoot, path).split("\\").join("/").startsWith(pluginPrefix),
  );
  const stableFiles = normalizedFiles(stableRoot).filter(
    (path) => !relative(stableRoot, path).split("\\").join("/").startsWith(pluginPrefix),
  );
  const releaseNames = releaseFiles.map((path) => relative(releaseRoot, path).split("\\").join("/"));
  const stableNames = stableFiles.map((path) => relative(stableRoot, path).split("\\").join("/"));
  if (JSON.stringify(releaseNames) !== JSON.stringify(stableNames)) {
    throw new Error("The stable Context adapter marketplace file set does not match the current release.");
  }
  for (let index = 0; index < releaseFiles.length; index += 1) {
    if (!readFileSync(releaseFiles[index] ?? "").equals(readFileSync(stableFiles[index] ?? ""))) {
      throw new Error(`The stable Context adapter marketplace differs at ${releaseNames[index] ?? "unknown"}.`);
    }
  }
}

export function contextPluginTreeDigest(root: string): string {
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Context Plugin payload root is not a real directory: ${root}`);
  }
  const hash = createHash("sha256");
  for (const path of normalizedFiles(root)) {
    hash.update(relative(root, path).split("\\").join("/"));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function assertLauncherExecutable(pluginRoot: string): void {
  for (const name of LAUNCHER_PATHS) {
    const launcherPath = join(pluginRoot, name);
    const launcher = lstatSync(launcherPath);
    if (!launcher.isFile() || launcher.isSymbolicLink() || (launcher.mode & 0o100) === 0) {
      throw new Error(`Context Plugin launcher is not an executable regular file: ${launcherPath}`);
    }
  }
}

function materializedFile(name: string, content: Buffer, adapterDigest: string, renderedInvocation: string): Buffer {
  if ((LAUNCHER_PATHS as readonly string[]).includes(name)) {
    const rendered = content.toString("utf8").replace("__FIRST_TREE_INVOCATION__", renderedInvocation);
    if (rendered.includes("__FIRST_TREE_INVOCATION__")) {
      throw new Error("Context integration launcher contains an unresolved CLI placeholder.");
    }
    return Buffer.from(rendered);
  }
  if (name === HOOK_PATH) {
    const rendered = content.toString("utf8").replaceAll("__ADAPTER_DIGEST__", adapterDigest);
    if (rendered.includes("__ADAPTER_DIGEST__")) {
      throw new Error("Context integration hook contains an unresolved adapter identity placeholder.");
    }
    return Buffer.from(rendered);
  }
  if (name.startsWith("skills/") && name.endsWith(".md")) {
    const rendered = content.toString("utf8").replaceAll("__FIRST_TREE_SKILL_INVOCATION__", renderedInvocation);
    if (rendered.includes("__FIRST_TREE_SKILL_INVOCATION__")) {
      throw new Error(`Context integration Skill contains an unresolved CLI placeholder at ${name}.`);
    }
    return Buffer.from(rendered);
  }
  return content;
}

function renderCliInvocation(invocation: ResolvedBinary): string {
  return invocation.kind === "bin"
    ? quotePosixShellArg(invocation.program)
    : [invocation.program, ...(invocation.args ?? [])].map(quotePosixShellArg).join(" ");
}

function normalizedFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Context Plugin payload contains a symbolic link: ${path}`);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) files.push(path);
      else throw new Error(`Context Plugin payload contains an unsupported entry: ${path}`);
    }
  };
  visit(root);
  return files;
}
