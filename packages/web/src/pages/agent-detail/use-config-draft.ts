import {
  type AgentRuntimeConfig,
  type AgentRuntimeConfigPayload,
  ENV_REDACTED_PLACEHOLDER,
  type EnvEntry,
  type GitRepo,
  type McpServer,
} from "@agent-team-foundation/first-tree-hub-shared";
import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Redesign M1: local draft state for the per-agent runtime config.
 *
 * The page loads a baseline from the server, all edits mutate the draft only,
 * and `buildPatch()` produces the PATCH body for the unified Save Bar.
 */

export type DraftListStatus = "unchanged" | "added" | "modified" | "deleted";

export type DraftListItem<T> = {
  /** Stable local id — used as React key and for undo/reorder. */
  key: string;
  /** Current draft value; for `deleted` items this is the baseline snapshot. */
  value: T;
  /** Server-side baseline at load time; null for newly added items. */
  baseline: T | null;
  status: DraftListStatus;
};

export type ConfigDraft = {
  promptAppend: string;
  model: string;
  mcp: Array<DraftListItem<McpServer>>;
  env: Array<DraftListItem<EnvEntry>>;
  git: Array<DraftListItem<GitRepo>>;
};

export type DraftSectionName = "prompt" | "model" | "mcp" | "env" | "git";

export type DraftSummary = {
  anyDirty: boolean;
  dirtySections: DraftSectionName[];
  counts: Record<DraftSectionName, number>;
};

function nextKey(prefix: string, existing: ReadonlySet<string>): string {
  let i = existing.size + 1;
  while (existing.has(`${prefix}-${i}`)) i++;
  return `${prefix}-${i}`;
}

function shallowEqualJson<T>(a: T, b: T): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function toListItems<T>(rows: readonly T[], prefix: string): Array<DraftListItem<T>> {
  return rows.map((v, i) => ({ key: `${prefix}-${i + 1}`, value: v, baseline: v, status: "unchanged" }));
}

function rebuildStatus<T>(list: Array<DraftListItem<T>>): Array<DraftListItem<T>> {
  return list.map((item) => {
    if (item.status === "deleted") return item;
    if (item.baseline == null) return { ...item, status: "added" };
    if (!shallowEqualJson(item.value, item.baseline)) return { ...item, status: "modified" };
    return { ...item, status: "unchanged" };
  });
}

type Mutator = (fn: (d: ConfigDraft) => ConfigDraft) => void;

function makeListOps<T>(section: "mcp" | "env" | "git", mutate: Mutator) {
  const prefix = section;
  return {
    add: (value: T) =>
      mutate((d) => {
        const list = d[section] as Array<DraftListItem<T>>;
        const keys = new Set(list.map((i) => i.key));
        const k = nextKey(prefix, keys);
        const next: Array<DraftListItem<T>> = [...list, { key: k, value, baseline: null, status: "added" }];
        return { ...d, [section]: rebuildStatus(next) };
      }),
    update: (key: string, value: T) =>
      mutate((d) => {
        const list = d[section] as Array<DraftListItem<T>>;
        const next = list.map((it) => (it.key === key ? { ...it, value } : it));
        return { ...d, [section]: rebuildStatus(next) };
      }),
    remove: (key: string) =>
      mutate((d) => {
        const list = d[section] as Array<DraftListItem<T>>;
        const next: Array<DraftListItem<T>> = list
          .map((it) => {
            if (it.key !== key) return it;
            if (it.baseline == null) return null; // added → drop outright
            return { ...it, status: "deleted" as DraftListStatus };
          })
          .filter((x): x is DraftListItem<T> => x !== null);
        return { ...d, [section]: next };
      }),
    undo: (key: string) =>
      mutate((d) => {
        const list = d[section] as Array<DraftListItem<T>>;
        const next = list.map((it) => {
          if (it.key !== key) return it;
          if (it.baseline == null) return it;
          return { ...it, value: it.baseline, status: "unchanged" as DraftListStatus };
        });
        return { ...d, [section]: next };
      }),
  };
}

function seedDraft(cfg: AgentRuntimeConfig): ConfigDraft {
  return {
    promptAppend: cfg.payload.prompt.append,
    model: cfg.payload.model,
    mcp: toListItems(cfg.payload.mcpServers, "mcp"),
    env: toListItems(cfg.payload.env, "env"),
    git: toListItems(cfg.payload.gitRepos, "git"),
  };
}

export type UseConfigDraftResult = {
  draft: ConfigDraft;
  summary: DraftSummary;
  promptDirty: boolean;
  modelDirty: boolean;
  setPromptAppend: (v: string) => void;
  revertPrompt: () => void;
  setModel: (v: string) => void;
  revertModel: () => void;
  addMcp: (value: McpServer) => void;
  updateMcp: (key: string, value: McpServer) => void;
  deleteMcp: (key: string) => void;
  undoDeleteMcp: (key: string) => void;
  addEnv: (value: EnvEntry) => void;
  updateEnv: (key: string, value: EnvEntry) => void;
  deleteEnv: (key: string) => void;
  undoDeleteEnv: (key: string) => void;
  addGit: (value: GitRepo) => void;
  updateGit: (key: string, value: GitRepo) => void;
  deleteGit: (key: string) => void;
  undoDeleteGit: (key: string) => void;
  resetAll: () => void;
  /** PATCH body (payload only — expectedVersion is added by caller). */
  buildPayloadPatch: () => Partial<AgentRuntimeConfigPayload>;
};

export function useConfigDraft(cfg: AgentRuntimeConfig | undefined): UseConfigDraftResult {
  const [draft, setDraft] = useState<ConfigDraft | null>(null);

  // Seed the draft once the config loads, and re-seed ONLY when the draft
  // has been reset to null (e.g. by the caller after a successful save or an
  // explicit reload). A refetch that lands mid-edit (focus/route-return
  // invalidation) previously stomped the user's in-progress changes; now we
  // ignore it and trust the caller to drop the draft when they want to pick
  // up server changes.
  useEffect(() => {
    if (cfg && draft === null) setDraft(seedDraft(cfg));
  }, [cfg, draft]);

  const current: ConfigDraft = draft ?? { promptAppend: "", model: "", mcp: [], env: [], git: [] };

  const baselinePrompt = cfg?.payload.prompt.append ?? "";
  const baselineModel = cfg?.payload.model ?? "";
  const promptDirty = current.promptAppend !== baselinePrompt;
  const modelDirty = current.model !== baselineModel;

  const summary: DraftSummary = useMemo(() => {
    const dirty: DraftSectionName[] = [];
    const listCount = (xs: Array<DraftListItem<unknown>>) =>
      xs.reduce((n, x) => (x.status === "unchanged" ? n : n + 1), 0);
    const mcpN = listCount(current.mcp);
    const envN = listCount(current.env);
    const gitN = listCount(current.git);
    if (promptDirty) dirty.push("prompt");
    if (modelDirty) dirty.push("model");
    if (mcpN > 0) dirty.push("mcp");
    if (envN > 0) dirty.push("env");
    if (gitN > 0) dirty.push("git");
    return {
      anyDirty: dirty.length > 0,
      dirtySections: dirty,
      counts: {
        prompt: promptDirty ? 1 : 0,
        model: modelDirty ? 1 : 0,
        mcp: mcpN,
        env: envN,
        git: gitN,
      },
    };
  }, [current, promptDirty, modelDirty]);

  const mutate = useCallback((fn: (d: ConfigDraft) => ConfigDraft) => {
    setDraft((prev) => (prev ? fn(prev) : prev));
  }, []);

  const setPromptAppend = useCallback((v: string) => mutate((d) => ({ ...d, promptAppend: v })), [mutate]);
  const revertPrompt = useCallback(
    () => mutate((d) => ({ ...d, promptAppend: baselinePrompt })),
    [mutate, baselinePrompt],
  );

  const setModel = useCallback((v: string) => mutate((d) => ({ ...d, model: v })), [mutate]);
  const revertModel = useCallback(() => mutate((d) => ({ ...d, model: baselineModel })), [mutate, baselineModel]);

  const mcpOps = useMemo(() => makeListOps<McpServer>("mcp", mutate), [mutate]);
  const envOps = useMemo(() => makeListOps<EnvEntry>("env", mutate), [mutate]);
  const gitOps = useMemo(() => makeListOps<GitRepo>("git", mutate), [mutate]);

  // Drop the draft — the useEffect above will re-seed on the next render
  // with whatever cfg React Query delivers (most recent save response or
  // refetched baseline). Works correctly whether cfg has already updated
  // synchronously (setQueryData) or is mid-refetch (invalidateQueries).
  const resetAll = useCallback(() => {
    setDraft(null);
  }, []);

  const buildPayloadPatch = useCallback((): Partial<AgentRuntimeConfigPayload> => {
    if (!draft || !cfg) return {};
    const patch: Partial<AgentRuntimeConfigPayload> = {};
    if (promptDirty) patch.prompt = { append: draft.promptAppend };
    if (modelDirty) patch.model = draft.model;
    const mcpDirty = summary.counts.mcp > 0;
    const envDirty = summary.counts.env > 0;
    const gitDirty = summary.counts.git > 0;
    if (mcpDirty) patch.mcpServers = draft.mcp.filter((i) => i.status !== "deleted").map((i) => i.value);
    if (envDirty) {
      patch.env = draft.env
        .filter((i) => i.status !== "deleted")
        .map((i) => {
          const v = i.value;
          if (v.sensitive && v.value === ENV_REDACTED_PLACEHOLDER) {
            return { key: v.key, value: ENV_REDACTED_PLACEHOLDER, sensitive: true };
          }
          return v;
        });
    }
    if (gitDirty) patch.gitRepos = draft.git.filter((i) => i.status !== "deleted").map((i) => i.value);
    return patch;
  }, [draft, cfg, promptDirty, modelDirty, summary]);

  return {
    draft: current,
    summary,
    promptDirty,
    modelDirty,
    setPromptAppend,
    revertPrompt,
    setModel,
    revertModel,
    addMcp: mcpOps.add,
    updateMcp: mcpOps.update,
    deleteMcp: mcpOps.remove,
    undoDeleteMcp: mcpOps.undo,
    addEnv: envOps.add,
    updateEnv: envOps.update,
    deleteEnv: envOps.remove,
    undoDeleteEnv: envOps.undo,
    addGit: gitOps.add,
    updateGit: gitOps.update,
    deleteGit: gitOps.remove,
    undoDeleteGit: gitOps.undo,
    resetAll,
    buildPayloadPatch,
  };
}
