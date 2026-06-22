import { describe, expect, it } from "vitest";
import { buildTabs, tabKeysFor } from "../tabs.js";

describe("agent-detail tabs", () => {
  it("gives an editor the engine-first 6-tab set with Repositories inserted before Usage", () => {
    const tabs = buildTabs(true, false);
    expect(tabs.map((t) => t.key)).toEqual(["profile", "runtime", "prompt", "capabilities", "repositories", "usage"]);
    expect(tabs.map((t) => t.label)).toEqual([
      "Profile",
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

  it("keeps Repositories (and Runtime) editor-only for non-editor agents", () => {
    // Non-editor, non-human: only Profile / Tools & skills / Usage — no runtime,
    // no repositories (repos + context tree were never visible to non-editors).
    expect(tabKeysFor(false, false).map((t) => t.key)).toEqual(["profile", "capabilities", "usage"]);
  });

  it("gives a human agent only Profile", () => {
    // A human is always canEditConfig=false (it derives from type !== "human").
    expect(tabKeysFor(false, true).map((t) => t.key)).toEqual(["profile"]);
  });
});
