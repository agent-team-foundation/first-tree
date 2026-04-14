import { statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Repo } from "#engine/repo.js";
import { readBootstrapState } from "#engine/runtime/bootstrap.js";
import { readSourceState } from "#engine/runtime/binding-state.js";
import {
  readLocalTreeConfig,
  resolveConfiguredLocalTreePath,
} from "#engine/runtime/local-tree-config.js";

import {
  SOURCE_INTEGRATION_BEGIN,
  SOURCE_INTEGRATION_END,
  SOURCE_INTEGRATION_FILES,
  SOURCE_INTEGRATION_MARKER,
  TREE_REPO_MARKER,
} from "#engine/runtime/asset-loader.js";

export const DEFAULT_TREE_REPO_SUFFIX = "-tree";
export const LEGACY_TREE_REPO_SUFFIX = "-context";

interface ExistingTreeCandidate {
  bootstrapMatchesSource: boolean;
  bootstrapTreeRepoName: string | null;
  root: string;
  treeRepoName: string;
}

type DedicatedTreeResolutionSource =
  | "bound-local"
  | "bound-sibling"
  | "default"
  | "local"
  | "sibling";

export interface DedicatedTreeResolution {
  root: string;
  source: DedicatedTreeResolutionSource;
  treeRepoName: string;
}

interface SuccessfulResolution {
  ok: true;
  value: DedicatedTreeResolution;
}

interface FailedResolution {
  message: string;
  ok: false;
}

const SOURCE_INTEGRATION_TREE_RE =
  /FIRST-TREE-TREE-REPO:\s+`([^`]+)`/;
const LEGACY_SOURCE_INTEGRATION_TREE_RE =
  /FIRST-TREE-SOURCE-INTEGRATION:.*?`([^`]+)` repo(?:\/submodule)?/;
const MANAGED_SOURCE_INTEGRATION_TREE_RE =
  /Keep all Context Tree files only in the dedicated `([^`]+)` repo(?:\/submodule)?\./;

export function buildDefaultTreeRepoName(sourceRepoName: string): string {
  return `${sourceRepoName}${DEFAULT_TREE_REPO_SUFFIX}`;
}

export function buildLegacyTreeRepoName(sourceRepoName: string): string {
  return `${sourceRepoName}${LEGACY_TREE_REPO_SUFFIX}`;
}

export function supportedDedicatedTreeRepoNames(sourceRepoName: string): string[] {
  return [
    buildDefaultTreeRepoName(sourceRepoName),
    buildLegacyTreeRepoName(sourceRepoName),
  ];
}

export function inferSourceRepoNameFromTreeRepoName(
  treeRepoName: string,
): string | null {
  for (const suffix of [DEFAULT_TREE_REPO_SUFFIX, LEGACY_TREE_REPO_SUFFIX]) {
    if (treeRepoName.endsWith(suffix) && treeRepoName.length > suffix.length) {
      return treeRepoName.slice(0, -suffix.length);
    }
  }
  return null;
}

export function parseTreeRepoNameFromSourceIntegration(
  text: string | null,
): string | null {
  if (text === null) {
    return null;
  }

  const normalized = text.replaceAll("\r\n", "\n");
  const candidateSections = extractSourceIntegrationSections(normalized);

  for (const section of candidateSections) {
    const directMatch = section.match(SOURCE_INTEGRATION_TREE_RE);
    if (directMatch?.[1]) {
      return directMatch[1];
    }

    const legacyMatch = section.match(LEGACY_SOURCE_INTEGRATION_TREE_RE);
    if (legacyMatch?.[1]) {
      return legacyMatch[1];
    }

    const managedMatch = section.match(MANAGED_SOURCE_INTEGRATION_TREE_RE);
    if (managedMatch?.[1]) {
      return managedMatch[1];
    }
  }

  return null;
}

export function readBoundTreeRepoNameFromSourceRepo(repo: Repo): string | null {
  const sourceState = readSourceState(repo.root);
  if (sourceState !== null) {
    return sourceState.tree.treeRepoName;
  }

  const localTreeConfig = readLocalTreeConfig(repo.root);
  if (localTreeConfig !== null) {
    return localTreeConfig.treeRepoName;
  }

  for (const file of SOURCE_INTEGRATION_FILES) {
    const treeRepoName = parseTreeRepoNameFromSourceIntegration(repo.readFile(file));
    if (treeRepoName !== null) {
      return treeRepoName;
    }
  }
  return null;
}

export function relativeRepoPath(from: string, to: string): string {
  const rel = relative(from, to);
  if (rel === "") {
    return ".";
  }
  return rel.startsWith("..") ? rel : `./${rel}`;
}

export function dedicatedTreePathOptions(sourceRepo: Repo): string[] {
  const resolution = resolveDedicatedTreeRepoForSource(sourceRepo);
  if (resolution.ok) {
    return [relativeRepoPath(sourceRepo.root, resolution.value.root)];
  }

  return [
    `../${buildDefaultTreeRepoName(sourceRepo.repoName())}`,
    `../${buildLegacyTreeRepoName(sourceRepo.repoName())}`,
  ];
}

export function formatDedicatedTreePathExample(
  command: string,
  sourceRepo: Repo,
): string {
  const paths = [...new Set(dedicatedTreePathOptions(sourceRepo))];
  if (paths.length === 1) {
    return `\`${command} --tree-path ${paths[0]}\``;
  }
  return `either \`${command} --tree-path ${paths[0]}\` or \`${command} --tree-path ${paths[1]}\``;
}

export function resolveDedicatedTreeRepoForSource(
  sourceRepo: Repo,
): FailedResolution | SuccessfulResolution {
  const boundTreeRepoName = readBoundTreeRepoNameFromSourceRepo(sourceRepo);
  if (boundTreeRepoName !== null) {
    const localCandidates = inspectExistingCandidates(
      localCandidatePaths(sourceRepo, [boundTreeRepoName]),
      sourceRepo,
    ).filter((candidate) => candidateMatchesBoundName(candidate, boundTreeRepoName));
    const chosenLocal = pickBoundCandidate(localCandidates);
    if (chosenLocal === "ambiguous") {
      return {
        ok: false,
        message: buildAmbiguousTreeRepoMessage(sourceRepo, localCandidates),
      };
    }
    if (chosenLocal !== null) {
      return {
        ok: true,
        value: {
          root: chosenLocal.root,
          source: "bound-local",
          treeRepoName: boundTreeRepoName,
        },
      };
    }

    const siblingPath = join(dirname(sourceRepo.root), boundTreeRepoName);
    const siblingCandidate = inspectExistingCandidate(siblingPath, sourceRepo);
    if (
      siblingCandidate !== null
      && candidateMatchesBoundName(siblingCandidate, boundTreeRepoName)
    ) {
      return {
        ok: true,
        value: {
          root: siblingCandidate.root,
          source: "bound-sibling",
          treeRepoName: boundTreeRepoName,
        },
      };
    }

    return {
      ok: true,
      value: {
        root: siblingPath,
        source: "bound-sibling",
        treeRepoName: boundTreeRepoName,
      },
    };
  }

  const localCandidates = inspectExistingCandidates(
    localCandidatePaths(sourceRepo),
    sourceRepo,
  ).filter((candidate) => candidateBelongsToSource(candidate, sourceRepo));
  const chosenLocal = pickPreferredCandidate(localCandidates);
  if (chosenLocal === "ambiguous") {
    return {
      ok: false,
      message: buildAmbiguousTreeRepoMessage(sourceRepo, localCandidates),
    };
  }
  if (chosenLocal !== null) {
    return {
      ok: true,
      value: {
        root: chosenLocal.root,
        source: "local",
        treeRepoName: chosenLocal.bootstrapTreeRepoName ?? chosenLocal.treeRepoName,
      },
    };
  }

  const siblingCandidates = inspectExistingCandidates(
    supportedDedicatedTreeRepoNames(sourceRepo.repoName()).map((name) =>
      join(dirname(sourceRepo.root), name)
    ),
    sourceRepo,
  ).filter((candidate) => candidateBelongsToSource(candidate, sourceRepo));
  const chosenSibling = pickPreferredCandidate(siblingCandidates);
  if (chosenSibling === "ambiguous") {
    return {
      ok: false,
      message: buildAmbiguousTreeRepoMessage(sourceRepo, siblingCandidates),
    };
  }
  if (chosenSibling !== null) {
    return {
      ok: true,
      value: {
        root: chosenSibling.root,
        source: "sibling",
        treeRepoName: chosenSibling.bootstrapTreeRepoName ?? chosenSibling.treeRepoName,
      },
    };
  }

  return {
    ok: true,
    value: {
      root: join(
        dirname(sourceRepo.root),
        buildDefaultTreeRepoName(sourceRepo.repoName()),
      ),
      source: "default",
      treeRepoName: buildDefaultTreeRepoName(sourceRepo.repoName()),
    },
  };
}

function localCandidatePaths(sourceRepo: Repo, extraNames: string[] = []): string[] {
  const paths = new Set<string>();
  const configuredLocalPath = resolveConfiguredLocalTreePath(sourceRepo.root);
  if (configuredLocalPath !== null && isGitRepoPath(configuredLocalPath)) {
    paths.add(configuredLocalPath);
  }
  for (const treeRepoName of [
    ...extraNames,
  ]) {
    const path = join(sourceRepo.root, treeRepoName);
    if (isGitRepoPath(path)) {
      paths.add(path);
    }
  }
  return [...paths];
}

function inspectExistingCandidates(
  paths: string[],
  sourceRepo: Repo,
): ExistingTreeCandidate[] {
  const seen = new Set<string>();
  const results: ExistingTreeCandidate[] = [];

  for (const path of paths) {
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    const candidate = inspectExistingCandidate(path, sourceRepo);
    if (candidate !== null) {
      results.push(candidate);
    }
  }

  return results;
}

function inspectExistingCandidate(
  path: string,
  sourceRepo: Repo,
): ExistingTreeCandidate | null {
  try {
    if (!statSync(path).isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }

  let bootstrapMatchesSource = false;
  let bootstrapTreeRepoName: string | null = null;

  const repo = new Repo(path);
  if (repo.isGitRepo()) {
    const bootstrap = readBootstrapState(path);
    if (bootstrap !== null) {
      bootstrapTreeRepoName = bootstrap.treeRepoName;
      const resolvedSourceRoot = resolve(path, bootstrap.sourceRepoPath);
      bootstrapMatchesSource =
        resolvedSourceRoot === sourceRepo.root
        || bootstrap.sourceRepoName === sourceRepo.repoName();
    }
  }

  return {
    bootstrapMatchesSource,
    bootstrapTreeRepoName,
    root: path,
    treeRepoName: basename(path),
  };
}

function candidateBelongsToSource(
  candidate: ExistingTreeCandidate,
  sourceRepo: Repo,
): boolean {
  if (candidate.bootstrapMatchesSource) {
    return true;
  }

  if (
    inferSourceRepoNameFromTreeRepoName(candidate.treeRepoName) === sourceRepo.repoName()
  ) {
    return true;
  }

  return (
    candidate.bootstrapTreeRepoName !== null
    && inferSourceRepoNameFromTreeRepoName(candidate.bootstrapTreeRepoName)
      === sourceRepo.repoName()
  );
}

function candidateMatchesBoundName(
  candidate: ExistingTreeCandidate,
  boundTreeRepoName: string,
): boolean {
  return (
    candidate.treeRepoName === boundTreeRepoName
    || candidate.bootstrapTreeRepoName === boundTreeRepoName
  );
}

function pickBoundCandidate(
  candidates: ExistingTreeCandidate[],
): ExistingTreeCandidate | "ambiguous" | null {
  if (candidates.length === 0) {
    return null;
  }

  const exactBootstrap = candidates.filter(
    (candidate) =>
      candidate.bootstrapMatchesSource
      && candidate.bootstrapTreeRepoName !== null
      && candidate.bootstrapTreeRepoName === candidate.treeRepoName,
  );
  if (exactBootstrap.length === 1) {
    return exactBootstrap[0];
  }
  if (exactBootstrap.length > 1) {
    return "ambiguous";
  }

  const boundBootstrap = candidates.filter(
    (candidate) => candidate.bootstrapMatchesSource,
  );
  if (boundBootstrap.length === 1) {
    return boundBootstrap[0];
  }
  if (boundBootstrap.length > 1) {
    return "ambiguous";
  }

  return candidates[0];
}

function pickPreferredCandidate(
  candidates: ExistingTreeCandidate[],
): ExistingTreeCandidate | "ambiguous" | null {
  if (candidates.length === 0) {
    return null;
  }

  const bootstrapMatches = candidates.filter(
    (candidate) => candidate.bootstrapMatchesSource,
  );
  if (bootstrapMatches.length === 1) {
    return bootstrapMatches[0];
  }
  if (bootstrapMatches.length > 1) {
    return "ambiguous";
  }

  if (candidates.length === 1) {
    return candidates[0];
  }

  return "ambiguous";
}

function buildAmbiguousTreeRepoMessage(
  sourceRepo: Repo,
  candidates: ExistingTreeCandidate[],
): string {
  const displays = [...new Set(
    candidates.map((candidate) => `\`${relativeRepoPath(sourceRepo.root, candidate.root)}\``),
  )];
  return (
    `found multiple dedicated tree repo candidates for \`${sourceRepo.repoName()}\`: ${
      displays.join(", ")
    }. Add or update the ${SOURCE_INTEGRATION_MARKER} line, or pass ` +
    "`--tree-path` / `--tree-name` explicitly."
  );
}

function isGitRepoPath(path: string): boolean {
  try {
    const gitPath = join(path, ".git");
    const stat = statSync(gitPath);
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

function extractSourceIntegrationSections(text: string): string[] {
  const managedBlockRe = new RegExp(
    `${escapeRegExp(SOURCE_INTEGRATION_BEGIN)}[\\s\\S]*?${escapeRegExp(SOURCE_INTEGRATION_END)}`,
    "g",
  );
  const managedBlocks = text.match(managedBlockRe);
  if (managedBlocks !== null) {
    return managedBlocks;
  }
  if (!text.includes(SOURCE_INTEGRATION_MARKER)) {
    return [];
  }
  return [text];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
