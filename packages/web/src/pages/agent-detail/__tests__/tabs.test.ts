import { describe, expect, it } from "vitest";
import {
  buildTabs,
  isConfirmedEmptyResponsibilitiesSide,
  type ResponsibilitiesSideState,
  type ResponsibilitiesVisibilityInput,
  responsibilitiesSideFromQuery,
  shouldShowResponsibilitiesTab,
  tabKeysFor,
} from "../tabs.js";

function side(overrides: Partial<ResponsibilitiesSideState> = {}): ResponsibilitiesSideState {
  return {
    hasData: true,
    isFetching: false,
    hasError: false,
    count: 0,
    ...overrides,
  };
}

function visibility(
  overrides: { catalog?: Partial<ResponsibilitiesSideState>; agentResources?: Partial<ResponsibilitiesSideState> } = {},
): ResponsibilitiesVisibilityInput {
  return {
    catalog: side({ count: 1, ...overrides.catalog }),
    agentResources: side({ count: 0, ...overrides.agentResources }),
  };
}

describe("agent-detail tabs", () => {
  it("gives an editor the 7-tab set with Responsibilities after Profile", () => {
    const tabs = buildTabs(true, false);
    expect(tabs.map((t) => t.key)).toEqual([
      "profile",
      "responsibilities",
      "runtime",
      "prompt",
      "capabilities",
      "repositories",
      "usage",
    ]);
    expect(tabs.map((t) => t.label)).toEqual([
      "Profile",
      "Responsibilities",
      "Runtime",
      "Instructions",
      "Tools & skills",
      "Repositories",
      "Usage",
    ]);
    // path stays equal to key for every tab (deep-link stability).
    expect(tabs.every((t) => t.path === t.key)).toBe(true);
  });

  it("renames runtime away from the old 'Environment' label", () => {
    const runtime = buildTabs(true, false).find((t) => t.key === "runtime");
    expect(runtime?.label).toBe("Runtime");
  });

  it("shows Responsibilities read-only while keeping Repositories and Runtime editor-only", () => {
    // Non-editor, non-human: Responsibilities remains visible, while runtime
    // and repositories keep their existing manager-only visibility.
    expect(tabKeysFor(false, false).map((t) => t.key)).toEqual([
      "profile",
      "responsibilities",
      "capabilities",
      "usage",
    ]);
  });

  it("gives a human agent only Profile", () => {
    // A human is always canEditConfig=false (it derives from type !== "human").
    expect(tabKeysFor(false, true).map((t) => t.key)).toEqual(["profile"]);
  });

  it("never grants Responsibilities to a human even when the caller passes true", () => {
    expect(tabKeysFor(false, true, true).map((t) => t.key)).toEqual(["profile"]);
    expect(buildTabs(false, true, true).map((t) => t.key)).toEqual(["profile"]);
  });

  it("omits Responsibilities when the empty-catalog gate is closed", () => {
    expect(tabKeysFor(true, false, false).map((t) => t.key)).toEqual([
      "profile",
      "runtime",
      "prompt",
      "capabilities",
      "repositories",
      "usage",
    ]);
    expect(tabKeysFor(false, false, false).map((t) => t.key)).toEqual(["profile", "capabilities", "usage"]);
  });
});

describe("shouldShowResponsibilitiesTab", () => {
  it("never shows for humans", () => {
    expect(
      shouldShowResponsibilitiesTab(true, visibility({ catalog: { count: 3 }, agentResources: { count: 2 } })),
    ).toBe(false);
  });

  it("hides only when catalog and agent templateIds are both confirmed empty", () => {
    expect(
      shouldShowResponsibilitiesTab(false, visibility({ catalog: { count: 0 }, agentResources: { count: 0 } })),
    ).toBe(false);
  });

  it("keeps the tab when the agent still has adopted templateIds even if the catalog is empty", () => {
    expect(
      shouldShowResponsibilitiesTab(false, visibility({ catalog: { count: 0 }, agentResources: { count: 2 } })),
    ).toBe(true);
  });

  it("keeps the tab while the catalog is loading or errored", () => {
    expect(
      shouldShowResponsibilitiesTab(
        false,
        visibility({
          catalog: { hasData: false, isFetching: true, count: 0 },
          agentResources: { count: 0 },
        }),
      ),
    ).toBe(true);
    expect(
      shouldShowResponsibilitiesTab(
        false,
        visibility({
          catalog: { hasData: false, hasError: true, count: 0 },
          agentResources: { count: 0 },
        }),
      ),
    ).toBe(true);
  });

  it("keeps the tab while agent resources are loading or initially errored", () => {
    expect(
      shouldShowResponsibilitiesTab(
        false,
        visibility({
          catalog: { count: 0 },
          agentResources: { hasData: false, isFetching: true, count: 0 },
        }),
      ),
    ).toBe(true);
    expect(
      shouldShowResponsibilitiesTab(
        false,
        visibility({
          catalog: { count: 0 },
          agentResources: { hasData: false, hasError: true, count: 0 },
        }),
      ),
    ).toBe(true);
  });

  it("fail-opens when cached-empty agent-resources has a background refetch error", () => {
    // React Query retains empty data and sets isError on refetch failure.
    expect(
      shouldShowResponsibilitiesTab(
        false,
        visibility({
          catalog: { count: 0 },
          agentResources: { hasData: true, hasError: true, count: 0 },
        }),
      ),
    ).toBe(true);
    expect(isConfirmedEmptyResponsibilitiesSide(side({ hasData: true, hasError: true, count: 0 }))).toBe(false);
  });

  it("fail-opens while a cached-empty side is refetching, then can close after settled empty", () => {
    expect(
      shouldShowResponsibilitiesTab(
        false,
        visibility({
          catalog: { count: 0 },
          agentResources: { hasData: true, isFetching: true, count: 0 },
        }),
      ),
    ).toBe(true);
    expect(
      shouldShowResponsibilitiesTab(
        false,
        visibility({
          catalog: { hasData: true, isFetching: true, count: 0 },
          agentResources: { count: 0 },
        }),
      ),
    ).toBe(true);
    expect(
      shouldShowResponsibilitiesTab(false, visibility({ catalog: { count: 0 }, agentResources: { count: 0 } })),
    ).toBe(false);
  });

  it("fail-opens when agent resources are unknown, loading, or errored", () => {
    expect(
      shouldShowResponsibilitiesTab(
        false,
        visibility({
          catalog: { count: 0 },
          agentResources: { hasData: false, count: 0 },
        }),
      ),
    ).toBe(true);
    expect(
      shouldShowResponsibilitiesTab(
        false,
        visibility({
          catalog: { count: 0 },
          agentResources: { hasData: false, isFetching: true, count: 0 },
        }),
      ),
    ).toBe(true);
    expect(
      shouldShowResponsibilitiesTab(
        false,
        visibility({
          catalog: { count: 0 },
          agentResources: { hasData: false, hasError: true, count: 0 },
        }),
      ),
    ).toBe(true);
  });

  it("maps React Query observations without treating retained data as settled success on error", () => {
    const cachedEmptyWithRefetchError = responsibilitiesSideFromQuery({
      count: 0,
      isFetching: false,
      isError: true,
    });
    expect(cachedEmptyWithRefetchError).toEqual({
      hasData: true,
      isFetching: false,
      hasError: true,
      count: 0,
    });
    expect(isConfirmedEmptyResponsibilitiesSide(cachedEmptyWithRefetchError)).toBe(false);

    const settledEmpty = responsibilitiesSideFromQuery({
      count: 0,
      isFetching: false,
      isError: false,
    });
    expect(isConfirmedEmptyResponsibilitiesSide(settledEmpty)).toBe(true);
  });
});
