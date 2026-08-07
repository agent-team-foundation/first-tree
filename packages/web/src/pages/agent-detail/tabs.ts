export type TabDef = { key: string; label: string; path: string; description: string };

// IA labels only. Routing `path` and the `key` (deep-link mapping) are kept
// stable so existing URLs keep resolving. Responsibilities has its own stable
// deep link alongside the previously added Runtime and Repositories routes.
const TAB_LABELS: Record<string, string> = {
  profile: "Profile",
  responsibilities: "Responsibilities",
  runtime: "Runtime",
  prompt: "Instructions",
  capabilities: "Tools & skills",
  repositories: "Repositories",
  usage: "Usage",
};

const TAB_DESCRIPTIONS: Record<string, string> = {
  profile: "Identity, ownership, and lifecycle for this agent.",
  responsibilities: "Starting responsibilities imported from Agent Templates.",
  runtime: "Where this agent runs and how it is configured.",
  prompt: "Guidance that shapes how this agent behaves.",
  capabilities: "Skills and integrations configured for this agent.",
  repositories: "Code repositories and team context available in this agent’s workspace.",
  usage: "Activity and turn history for this agent.",
};

/**
 * One side of the empty-entry gate (public catalog or agent-resources).
 *
 * Confirmed empty requires: data present from a successful response, no
 * in-flight fetch/refetch, no error (including background refetch errors that
 * retain cached data), and a zero count. Anything else is uncertain → fail open.
 */
export type ResponsibilitiesSideState = {
  hasData: boolean;
  isFetching: boolean;
  hasError: boolean;
  count: number;
};

export type ResponsibilitiesVisibilityInput = {
  catalog: ResponsibilitiesSideState;
  agentResources: ResponsibilitiesSideState;
};

/** Build a side state from a live React Query observation. */
export function responsibilitiesSideFromQuery(args: {
  /** `null` when the query has never produced data (or cache miss). */
  count: number | null;
  isFetching: boolean;
  isError: boolean;
}): ResponsibilitiesSideState {
  return {
    hasData: args.count != null,
    isFetching: args.isFetching,
    hasError: args.isError,
    count: args.count ?? 0,
  };
}

export function isConfirmedEmptyResponsibilitiesSide(side: ResponsibilitiesSideState): boolean {
  return side.hasData && !side.isFetching && !side.hasError && side.count === 0;
}

/**
 * Whether Agent Detail should expose the Responsibilities tab.
 *
 * Hide only when both the public catalog and the agent's adopted `templateIds`
 * are confirmed empty (latest request succeeded, not fetching/refetching, empty
 * arrays). Loading, in-flight background refetch, initial errors, and cached
 * data with a refetch error all fail open. Non-empty `templateIds` keep the tab
 * for provenance even when the official catalog is empty.
 */
export function shouldShowResponsibilitiesTab(
  isHuman: boolean,
  input: ResponsibilitiesVisibilityInput | null,
): boolean {
  if (isHuman) return false;
  if (!input) return true;
  // Provenance / available catalog: any known non-empty side keeps the entry.
  if (input.agentResources.hasData && input.agentResources.count > 0) return true;
  if (input.catalog.hasData && input.catalog.count > 0) return true;
  if (
    isConfirmedEmptyResponsibilitiesSide(input.catalog) &&
    isConfirmedEmptyResponsibilitiesSide(input.agentResources)
  ) {
    return false;
  }
  return true;
}

/**
 * Single source of truth for WHICH sections exist for an agent (key + path),
 * independent of label/order. `buildTabs` adds the display label and description.
 *
 * Humans never receive Responsibilities, even when a caller passes `true`.
 */
export function tabKeysFor(
  canEditConfig: boolean,
  isHuman: boolean,
  showResponsibilities: boolean = !isHuman,
): { key: string; path: string }[] {
  const tabs: { key: string; path: string }[] = [{ key: "profile", path: "profile" }];
  if (!isHuman && showResponsibilities) {
    tabs.push({ key: "responsibilities", path: "responsibilities" });
  }
  if (canEditConfig) {
    // Responsibility comes directly after identity, followed by Runtime
    // (model/effort/computer/env), Instructions, then the two resource tabs.
    // Repositories is editor-only — repos + the read-only context tree lived on
    // the old (editor-only) Environment tab, so non-editors never saw them and
    // still don't.
    tabs.push(
      { key: "runtime", path: "runtime" },
      { key: "prompt", path: "prompt" },
      { key: "capabilities", path: "capabilities" },
      { key: "repositories", path: "repositories" },
    );
  } else if (!isHuman) {
    tabs.push({ key: "capabilities", path: "capabilities" });
  }
  // Usage is an observation surface, kept last; human-type agents have no token usage.
  if (!isHuman) {
    tabs.push({ key: "usage", path: "usage" });
  }
  return tabs;
}

export function buildTabs(
  canEditConfig: boolean,
  isHuman: boolean,
  showResponsibilities: boolean = !isHuman,
): TabDef[] {
  return tabKeysFor(canEditConfig, isHuman, showResponsibilities).map((t) => ({
    ...t,
    label: TAB_LABELS[t.key] ?? t.key,
    description: TAB_DESCRIPTIONS[t.key] ?? "",
  }));
}
