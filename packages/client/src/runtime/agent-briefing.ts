import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  AGENT_BRIEFING_GENERATED_MARKER,
  type AgentRuntimeConfigPayload,
  type PromptSection,
} from "@first-tree/shared";
import type * as ejs from "ejs";
import type { PredeclaredSourceRepo } from "./bootstrap.js";
import { getCliBinding } from "./cli-binding.js";
import type { AgentIdentity } from "./handler.js";
import { buildResourceSkillBriefingRows, type ResourceSkillBriefingRow } from "./resource-skills.js";

const require = createRequire(import.meta.url);
// EJS is published as CommonJS at runtime even though its types expose named
// exports, so native ESM cannot import `render` directly.
const ejsRuntime: typeof ejs = require("ejs");
const AGENT_BRIEFING_TEMPLATE_FILENAME = "agent-briefing.ejs";
const TEMPLATE_CANDIDATE_URLS = [
  // Source execution: packages/client/src/runtime/agent-briefing.ts
  new URL(`./templates/${AGENT_BRIEFING_TEMPLATE_FILENAME}`, import.meta.url),
  // Bundled execution: packages/client/dist/index.mjs or apps/cli/dist/<chunk>.mjs
  new URL(`../templates/${AGENT_BRIEFING_TEMPLATE_FILENAME}`, import.meta.url),
] as const;

type CachedTemplate = {
  filename: string;
  source: string;
};

type NamedPromptRow = Readonly<{
  name: string;
  body: string;
}>;

type PromptBodyRow = Readonly<{
  body: string;
}>;

type SourceRepositoryRow = Readonly<{
  absolutePath: string;
  url: string;
  ref: string | null;
  branch: string | null;
}>;

type ContextTreeRenderModel = Readonly<{
  bound: boolean;
  path: string | null;
  upstreamUrl: string | null;
  branch: string;
  verifyCommand: string;
  hierarchyHelpCommand: string;
  cloneCommand: string | null;
  removeSymlinkCommand: string | null;
  pullCommand: string | null;
  addWorktreeCommand: string | null;
}>;

type AgentBriefingRenderModel = Readonly<{
  bin: string;
  generatedMarker: string;
  identityName: string;
  identityKind: string;
  agentId: string;
  teamPromptRows: ReadonlyArray<NamedPromptRow>;
  agentPromptRows: ReadonlyArray<PromptBodyRow>;
  agentPromptOverrideRows: ReadonlyArray<NamedPromptRow>;
  legacyPrompt: string | null;
  workspacePath: string;
  sourceRepositoryRows: ReadonlyArray<SourceRepositoryRow>;
  exampleSourcePath: string;
  readWorktreePath: string;
  taskWorktreePath: string;
  contextTree: ContextTreeRenderModel;
  resourceSkillRows: ReadonlyArray<ResourceSkillBriefingRow>;
}>;

let templateCache: CachedTemplate | null = null;

/** Wrap a runtime value in canonical POSIX-safe single quotes. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export type BuildAgentBriefingOptions = {
  identity: AgentIdentity;
  payload: AgentRuntimeConfigPayload | null;
  workspacePath: string;
  sourceRepos: ReadonlyArray<PredeclaredSourceRepo>;
  contextTreePath: string | null;
  /** Upstream coordinates used by the agent-managed Context Tree clone. */
  contextTreeRepoUrl?: string | null;
  contextTreeBranch?: string | null;
};

/** Build the unified agent-level briefing materialized as `AGENTS.md`. */
export function buildAgentBriefing(opts: BuildAgentBriefingOptions): string {
  return renderAgentBriefingTemplate(buildAgentBriefingRenderModel(opts));
}

function buildAgentBriefingRenderModel(opts: BuildAgentBriefingOptions): AgentBriefingRenderModel {
  const { binName: bin } = getCliBinding();
  const promptSections = opts.payload?.prompt.sections ?? [];
  const teamPromptRows = buildNamedPromptRows(
    promptSections.filter((section) => section.scope === "team"),
    "Team prompt",
  );
  const agentPromptRows = promptSections
    .filter((section) => section.scope === "agent" && section.editable === true && section.body.trim().length > 0)
    .map((section) => ({ body: section.body.trim() }));
  const agentPromptOverrideRows = buildNamedPromptRows(
    promptSections.filter((section) => section.scope === "agent" && section.editable !== true),
    "Agent prompt override",
  );
  const hasStructuredPrompt =
    teamPromptRows.length > 0 || agentPromptRows.length > 0 || agentPromptOverrideRows.length > 0;
  const legacyPrompt = hasStructuredPrompt ? null : opts.payload?.prompt.append?.trim() || null;

  const sourceRepositoryRows = opts.sourceRepos.map((repo) => ({
    absolutePath: repo.absolutePath,
    url: repo.url,
    ref: repo.ref ?? null,
    branch: repo.branch ?? null,
  }));
  const quotedWorkspacePath = shellQuote(opts.workspacePath);
  const exampleSourcePath = sourceRepositoryRows[0]
    ? shellQuote(sourceRepositoryRows[0].absolutePath)
    : `${quotedWorkspacePath}/source-repos/<source-repo>`;

  return {
    bin,
    generatedMarker: AGENT_BRIEFING_GENERATED_MARKER,
    identityName: opts.identity.displayName ?? opts.identity.agentId,
    identityKind: opts.identity.visibility === "private" ? "a personal assistant agent" : "an autonomous agent",
    agentId: opts.identity.agentId,
    teamPromptRows,
    agentPromptRows,
    agentPromptOverrideRows,
    legacyPrompt,
    workspacePath: opts.workspacePath,
    sourceRepositoryRows,
    exampleSourcePath,
    readWorktreePath: shellQuote(`${opts.workspacePath}/worktrees/<name>-read`),
    taskWorktreePath: shellQuote(`${opts.workspacePath}/worktrees/<task-name>`),
    contextTree: buildContextTreeRenderModel(
      bin,
      opts.contextTreePath,
      opts.contextTreeRepoUrl ?? null,
      opts.contextTreeBranch ?? null,
    ),
    resourceSkillRows: buildResourceSkillBriefingRows(opts.workspacePath, opts.payload),
  };
}

function buildNamedPromptRows(promptSections: ReadonlyArray<PromptSection>, fallbackName: string): NamedPromptRow[] {
  return promptSections
    .filter((section) => section.body.trim().length > 0)
    .map((section) => ({
      name: section.name.trim() || fallbackName,
      body: section.body.trim(),
    }));
}

function buildContextTreeRenderModel(
  bin: string,
  path: string | null,
  upstreamUrl: string | null,
  configuredBranch: string | null,
): ContextTreeRenderModel {
  const branch = configuredBranch ?? "main";
  if (path === null) {
    return {
      bound: false,
      path: null,
      upstreamUrl: null,
      branch,
      verifyCommand: `${bin} tree verify`,
      hierarchyHelpCommand: `${bin} tree tree --help`,
      cloneCommand: null,
      removeSymlinkCommand: null,
      pullCommand: null,
      addWorktreeCommand: null,
    };
  }

  const quotedPath = shellQuote(path);
  return {
    bound: true,
    path,
    upstreamUrl,
    branch,
    verifyCommand: `${bin} tree verify`,
    hierarchyHelpCommand: `${bin} tree tree --help`,
    cloneCommand: upstreamUrl
      ? `git clone --branch ${shellQuote(branch)} --single-branch ${shellQuote(upstreamUrl)} ${quotedPath}`
      : `git clone --branch <branch> --single-branch <tree-repo-url> ${quotedPath}`,
    removeSymlinkCommand: `rm ${quotedPath}`,
    pullCommand: `git -C ${quotedPath} pull --ff-only`,
    addWorktreeCommand: `git -C ${quotedPath} worktree add …`,
  };
}

function renderAgentBriefingTemplate(model: AgentBriefingRenderModel): string {
  const template = readAgentBriefingTemplate();
  return ejsRuntime.render(template.source, model, { filename: template.filename });
}

function readAgentBriefingTemplate(): CachedTemplate {
  if (templateCache) return templateCache;
  const filename = resolveAgentBriefingTemplatePath();
  templateCache = {
    filename,
    source: readFileSync(filename, "utf8"),
  };
  return templateCache;
}

export function resolveAgentBriefingTemplatePath(): string {
  for (const url of TEMPLATE_CANDIDATE_URLS) {
    const filename = fileURLToPath(url);
    if (existsSync(filename)) return filename;
  }
  throw new Error(
    `Agent briefing EJS template is missing. Expected ${AGENT_BRIEFING_TEMPLATE_FILENAME} in the client runtime templates assets.`,
  );
}

/** Names of the First Tree skills listed by both routing tables. */
export const FIRST_TREE_FAMILY_SKILL_NAMES = [
  "first-tree-welcome",
  "first-tree-write",
  "first-tree-read",
  "first-tree-seed",
  "first-tree-file-bug",
  "context-tree-review",
] as const;
