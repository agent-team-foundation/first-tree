import type { AgentRuntimeConfigPayload } from "@first-tree/shared";
import { type AgentBootstrapResult, ensureAgentBootstrap } from "../runtime/agent-bootstrap.js";
import { buildAgentBriefing } from "../runtime/agent-briefing.js";
import type { AgentConfigCache } from "../runtime/agent-config-cache.js";
import type { PredeclaredSourceRepo } from "../runtime/bootstrap.js";
import { type ChatContext, fetchChatContext } from "../runtime/chat-context.js";
import type { GitMirrorManager } from "../runtime/git-mirror-manager.js";
import type { SessionContext } from "../runtime/handler.js";
import { materializeResourceSkills } from "../runtime/resource-skills.js";
import { currentSourceRepoNamesFromPayload, prepareSourceRepos } from "../runtime/source-repos.js";
import { acquireAgentHome, markWorkspaceInitComplete } from "../runtime/workspace.js";

export type ProviderPayloadStrategy = "cached" | "refresh" | "cached-or-refresh";

export type ProviderEnvOptions = {
  stripClaudeCodeParentEnv?: boolean;
  trimUndefined?: boolean;
};

export type ProviderBootstrapResult<TPayload extends AgentRuntimeConfigPayload | undefined> = {
  cwd: string;
  payload: TPayload;
  payloadResolved: boolean;
  chatContext: ChatContext | undefined;
  sourceRepos: PredeclaredSourceRepo[];
  briefing: string;
  env: Record<string, string | undefined>;
  bootstrap: AgentBootstrapResult;
};

export type ProviderBootstrapDeps = {
  acquireAgentHome: (workspaceRoot: string) => string;
  fetchChatContext: typeof fetchChatContext;
  prepareSourceRepos: typeof prepareSourceRepos;
  materializeResourceSkills: typeof materializeResourceSkills;
  buildAgentBriefing: typeof buildAgentBriefing;
  ensureAgentBootstrap: typeof ensureAgentBootstrap;
  markWorkspaceInitComplete: typeof markWorkspaceInitComplete;
};

const defaultDeps: ProviderBootstrapDeps = {
  acquireAgentHome,
  fetchChatContext,
  prepareSourceRepos,
  materializeResourceSkills,
  buildAgentBriefing,
  ensureAgentBootstrap,
  markWorkspaceInitComplete,
};

type ProviderBootstrapOptionsBase = {
  workspaceRoot: string;
  sessionCtx: SessionContext;
  contextTreePath: string | null;
  agentConfigCache: AgentConfigCache | null;
  gitMirrorManager: GitMirrorManager | null;
  agentName: string | null;
  payloadStrategy: ProviderPayloadStrategy;
  envOptions?: ProviderEnvOptions;
  beforeBootstrap?: (input: { cwd: string; sessionCtx: SessionContext }) => void;
  deps?: Partial<ProviderBootstrapDeps>;
};

type ProviderBootstrapOptionsWithDefault = ProviderBootstrapOptionsBase & {
  defaultPayload: () => AgentRuntimeConfigPayload;
};

type ProviderBootstrapOptionsWithoutDefault = ProviderBootstrapOptionsBase & {
  defaultPayload?: undefined;
};

export function buildProviderEnv(
  sessionCtx: SessionContext,
  payload: AgentRuntimeConfigPayload | null | undefined,
  options: ProviderEnvOptions & { trimUndefined: true },
): Record<string, string>;
export function buildProviderEnv(
  sessionCtx: SessionContext,
  payload: AgentRuntimeConfigPayload | null | undefined,
  options?: ProviderEnvOptions,
): Record<string, string | undefined>;
export function buildProviderEnv(
  sessionCtx: SessionContext,
  payload: AgentRuntimeConfigPayload | null | undefined,
  options: ProviderEnvOptions = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" || !options.trimUndefined) env[key] = value;
  }

  if (options.stripClaudeCodeParentEnv) {
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
    delete env.npm_lifecycle_script;
  }

  for (const entry of payload?.env ?? []) {
    env[entry.key] = entry.value;
  }

  const merged = sessionCtx.buildAgentEnv(env);
  if (!options.trimUndefined) return merged;

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export async function prepareProviderBootstrap(
  options: ProviderBootstrapOptionsWithDefault,
): Promise<ProviderBootstrapResult<AgentRuntimeConfigPayload>>;
export async function prepareProviderBootstrap(
  options: ProviderBootstrapOptionsWithoutDefault,
): Promise<ProviderBootstrapResult<AgentRuntimeConfigPayload | undefined>>;
export async function prepareProviderBootstrap(
  options: ProviderBootstrapOptionsWithDefault | ProviderBootstrapOptionsWithoutDefault,
): Promise<ProviderBootstrapResult<AgentRuntimeConfigPayload | undefined>> {
  const deps = { ...defaultDeps, ...options.deps };
  const cwd = deps.acquireAgentHome(options.workspaceRoot);
  const { payload, payloadResolved } = await resolvePayload(options);
  const chatContext = await fetchChatContextOrLog(deps, options.sessionCtx);
  const sourceRepos = await deps.prepareSourceRepos({
    workspace: cwd,
    payload,
    sessionCtx: options.sessionCtx,
    gitMirrorManager: options.gitMirrorManager,
    agentName: options.agentName,
    payloadResolved,
  });
  await deps.materializeResourceSkills(cwd, payload, options.sessionCtx);

  const briefing = deps.buildAgentBriefing({
    identity: options.sessionCtx.agent,
    payload: payload ?? null,
    chatContext,
    workspacePath: cwd,
    sourceRepos,
    contextTreePath: options.contextTreePath,
  });
  options.beforeBootstrap?.({ cwd, sessionCtx: options.sessionCtx });
  const bootstrap = deps.ensureAgentBootstrap({
    workspace: cwd,
    sessionCtx: options.sessionCtx,
    contextTreePath: options.contextTreePath,
    briefing,
    currentSourceRepoNames: currentSourceRepoNamesFromPayload(payload, payloadResolved),
  });
  deps.markWorkspaceInitComplete(cwd);

  return {
    cwd,
    payload,
    payloadResolved,
    chatContext,
    sourceRepos,
    briefing,
    env: buildProviderEnv(options.sessionCtx, payload, options.envOptions),
    bootstrap,
  };
}

async function resolvePayload(
  options: ProviderBootstrapOptionsWithDefault | ProviderBootstrapOptionsWithoutDefault,
): Promise<{ payload: AgentRuntimeConfigPayload | undefined; payloadResolved: boolean }> {
  const agentId = options.sessionCtx.agent.agentId;
  let payload: AgentRuntimeConfigPayload | undefined;
  let payloadResolved = false;

  if (options.agentConfigCache) {
    if (options.payloadStrategy === "cached") {
      const cached = options.agentConfigCache.get(agentId);
      payload = cached?.payload;
      payloadResolved = cached !== undefined;
    } else if (options.payloadStrategy === "refresh") {
      payload = (await options.agentConfigCache.refresh(agentId)).payload;
      payloadResolved = true;
    } else {
      const cached = options.agentConfigCache.get(agentId);
      if (cached) {
        payload = cached.payload;
        payloadResolved = true;
      } else {
        payload = (await options.agentConfigCache.refresh(agentId)).payload;
        payloadResolved = true;
      }
    }
  }

  if (!payload && options.defaultPayload) {
    payload = options.defaultPayload();
  }
  return { payload, payloadResolved };
}

async function fetchChatContextOrLog(
  deps: ProviderBootstrapDeps,
  sessionCtx: SessionContext,
): Promise<ChatContext | undefined> {
  try {
    return await deps.fetchChatContext(sessionCtx.sdk, sessionCtx.chatId, sessionCtx.agent);
  } catch (err) {
    sessionCtx.log(`fetchChatContext failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}
