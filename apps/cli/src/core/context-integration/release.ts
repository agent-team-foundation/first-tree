import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ContextIntegrationProvider,
  type ContextIntegrationReleaseManifest,
  contextIntegrationReleaseManifestSchema,
} from "@first-tree/shared";
import { channelConfig } from "../channel.js";
import { COMMAND_VERSION } from "../version.js";

export type ContextIntegrationRelease = {
  root: string;
  coreRoot: string;
  manifest: ContextIntegrationReleaseManifest;
};

export function resolveContextIntegrationRelease(
  overrideRoot?: string,
  options: { coreRoot?: string; requirePinnedCoreRoot?: boolean } = {},
): ContextIntegrationRelease {
  const candidates = overrideRoot
    ? [overrideRoot]
    : [
        new URL("../../../context-integration/", import.meta.url),
        new URL("../../context-integration/", import.meta.url),
        new URL("../context-integration/", import.meta.url),
      ].map((url) => fileURLToPath(url));
  const root = candidates.find((candidate) => existsSync(join(candidate, "release-manifest.json")));
  if (!root) {
    throw new Error(
      "This First Tree installation does not contain the Context integration release payload. Reinstall or upgrade First Tree.",
    );
  }
  const manifest = contextIntegrationReleaseManifestSchema.parse(
    JSON.parse(readFileSync(join(root, "release-manifest.json"), "utf8")),
  );
  if (manifest.channel !== channelConfig.channel) {
    throw new Error(
      `Context integration channel mismatch: CLI is ${channelConfig.channel}, payload is ${manifest.channel}.`,
    );
  }
  if (COMMAND_VERSION !== "unknown" && manifest.version !== COMMAND_VERSION) {
    throw new Error(`Context integration version mismatch: CLI is ${COMMAND_VERSION}, payload is ${manifest.version}.`);
  }
  const release = {
    root: realDirectory(root, "Context integration release root"),
    coreRoot: realDirectory(options.coreRoot ?? resolveCoreRoot(root, manifest), "CLI exact release root"),
    manifest,
  };
  if (options.requirePinnedCoreRoot) assertPinnedExactReleaseRoot(release);
  verifyContextIntegrationRelease(release);
  return release;
}

export function verifyContextIntegrationRelease(release: ContextIntegrationRelease): void {
  for (const provider of ["claude-code", "codex"] as const) {
    const adapterRoot = join(release.root, provider);
    const pluginRoot = providerPluginRoot(release.root, provider);
    const adapterDigest = treeDigest(adapterRoot);
    if (adapterDigest !== release.manifest.providers[provider].adapterDigest) {
      throw new Error(`Context integration ${provider} adapter digest mismatch.`);
    }
    if (!existsSync(join(pluginRoot, "skills", "first-tree", "SKILL.md"))) {
      throw new Error(`External ${provider} Plugin must expose the first-tree manual activation Skill.`);
    }
    for (const skill of ["first-tree-read", "first-tree-write"]) {
      const entries = normalizedFiles(join(pluginRoot, "skills", skill));
      if (
        entries.length !== 1 ||
        relative(pluginRoot, entries[0] ?? "")
          .split("\\")
          .join("/") !== `skills/${skill}/SKILL.md`
      ) {
        throw new Error(`External ${provider} Plugin must keep ${skill} as a thin single-file loader stub.`);
      }
    }
    if (existsSync(join(pluginRoot, "skills", "first-tree-seed"))) {
      throw new Error(`External ${provider} Plugin must not expose first-tree-seed.`);
    }
  }
  const policyPath = resolveContextCorePath(release, release.manifest.core.policy.path);
  const policyDigest = sha256(readFileSync(policyPath));
  if (policyDigest !== release.manifest.core.policy.digest || policyDigest !== release.manifest.policyDigest) {
    throw new Error("Context integration canonical Policy digest mismatch.");
  }
  const skillDigests: Array<[string, string]> = [];
  for (const name of ["first-tree-read", "first-tree-write"] as const) {
    const entry = release.manifest.core.skills[name];
    const digest = sha256(readFileSync(resolveContextCorePath(release, entry.path)));
    if (digest !== entry.digest) {
      throw new Error(`Context integration canonical ${name} digest mismatch.`);
    }
    skillDigests.push([name, digest]);
  }
  const coreDigest = sha256(Buffer.from(JSON.stringify({ policy: policyDigest, skills: skillDigests })));
  if (coreDigest !== release.manifest.core.digest) {
    throw new Error("Context integration canonical Core digest mismatch.");
  }
  const bundleDigest = sha256(
    Buffer.from(
      JSON.stringify({
        coreDigest,
        policyDigest,
        providers: (["claude-code", "codex"] as const).map((provider) => [
          provider,
          release.manifest.providers[provider].adapterDigest,
        ]),
      }),
    ),
  );
  if (bundleDigest !== release.manifest.bundleDigest) {
    throw new Error("Context integration release bundle digest mismatch.");
  }
}

export function resolveContextCorePath(release: ContextIntegrationRelease, declaredPath: string): string {
  if (isAbsolute(declaredPath) || declaredPath.split(/[\\/]/u).includes("..")) {
    throw new Error(`Context integration Core path is not a safe release-relative path: ${declaredPath}`);
  }
  let candidate = resolve(release.coreRoot, declaredPath);
  if (
    !existsSync(candidate) &&
    release.manifest.channel === "dev" &&
    declaredPath === "dist/runtime-assets/context-tree-policy.md"
  ) {
    candidate = resolve(release.coreRoot, "packages/client/src/runtime/assets/context-tree-policy.md");
  }
  const stat = lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Context integration Core path is not a regular file: ${candidate}`);
  }
  const realCandidate = realpathSync(candidate);
  const fromRoot = relative(release.coreRoot, realCandidate);
  if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error(`Context integration Core path escapes the exact release root: ${candidate}`);
  }
  return realCandidate;
}

function resolveCoreRoot(root: string, manifest: ContextIntegrationReleaseManifest): string {
  const packagedRoot = dirname(root);
  if (existsSync(resolve(packagedRoot, manifest.core.skills["first-tree-read"].path))) return packagedRoot;
  if (manifest.channel === "dev") {
    // The dev payload is generated at apps/cli/context-integration, while the
    // canonical Skills remain at the repository root. Derive that root from
    // the verified payload location so this also works from the bundled CLI,
    // where import.meta.url points at dist/cli rather than this source file.
    const sourceRoot = resolve(packagedRoot, "../..");
    if (existsSync(resolve(sourceRoot, manifest.core.skills["first-tree-read"].path))) return sourceRoot;
    const moduleSourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
    if (existsSync(resolve(moduleSourceRoot, manifest.core.skills["first-tree-read"].path))) return moduleSourceRoot;
  }
  return packagedRoot;
}

function assertPinnedExactReleaseRoot(release: ContextIntegrationRelease): void {
  const appRoot = release.coreRoot;
  const versionRoot = dirname(appRoot);
  const versionsRoot = dirname(versionRoot);
  const releaseRelative = relative(appRoot, release.root);
  const pinnedLayout =
    basename(appRoot) === "app" &&
    basename(versionRoot) === release.manifest.version &&
    basename(versionsRoot) === "versions" &&
    releaseRelative !== "" &&
    !releaseRelative.startsWith("..") &&
    !isAbsolute(releaseRelative);
  if (!pinnedLayout) {
    throw new ContextReleaseRootUntrustedError(appRoot);
  }
  realDirectory(versionRoot, "CLI exact version root");
  realDirectory(versionsRoot, "CLI versions root");
}

export class ContextReleaseRootUntrustedError extends Error {
  readonly code = "CONTEXT_SKILL_RELEASE_ROOT_UNTRUSTED";

  constructor(path: string) {
    super(
      `First Tree Context cannot load Core Skills from a mutable CLI installation (${path}). Use a version-pinned portable First Tree release.`,
    );
    this.name = "ContextReleaseRootUntrustedError";
  }
}

export function providerPluginRoot(releaseRoot: string, provider: ContextIntegrationProvider): string {
  return join(releaseRoot, provider, "plugins", "first-tree-context");
}

export function treeDigest(root: string): string {
  const hash = createHash("sha256");
  for (const path of normalizedFiles(root)) {
    hash.update(relative(root, path).split("\\").join("/"));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function sha256(content: Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function realDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} is not a real directory: ${absolute}`);
  return realpathSync(absolute);
}

function normalizedFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Context integration release contains a symbolic link: ${path}`);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) files.push(path);
      else throw new Error(`Unsupported Context integration release entry: ${path}`);
    }
  };
  visit(root);
  return files;
}
