import { describe, expect, it } from "vitest";
import { deriveServiceSuffix } from "../core/service-install.js";

describe("deriveServiceSuffix", () => {
  it("returns empty string for the canonical 'hub' basename so prod unit names stay unchanged", () => {
    // Backwards compatibility: every machine already running prod has its
    // unit registered under `first-tree-hub-client.service` / `dev.first-tree-hub.client`.
    // The suffix derivation must NOT rename those out from under existing installs.
    expect(deriveServiceSuffix("hub")).toBe("");
  });

  it("strips the 'hub-' prefix so isolated dev homes produce a short, readable suffix", () => {
    expect(deriveServiceSuffix("hub-test")).toBe("test");
    expect(deriveServiceSuffix("hub-dev")).toBe("dev");
    expect(deriveServiceSuffix("hub-jane")).toBe("jane");
  });

  it("preserves multi-segment suffixes verbatim (no further mangling)", () => {
    expect(deriveServiceSuffix("hub-feat-rate-limit")).toBe("feat-rate-limit");
  });

  it("uses the entire basename for non-'hub-*' homes", () => {
    // A user who points FIRST_TREE_HUB_HOME at e.g. ~/.first-tree/scratch
    // gets `first-tree-hub-client-scratch.service` rather than colliding
    // with prod.
    expect(deriveServiceSuffix("scratch")).toBe("scratch");
    expect(deriveServiceSuffix("my-stuff")).toBe("my-stuff");
  });

  it("falls back to empty (= prod unit name) for empty input", () => {
    // Defensive: if basename() ever returns "" we'd rather degrade to the
    // prod unit name (which we already detect/handle) than write a weird
    // `first-tree-hub-client-.service`.
    expect(deriveServiceSuffix("")).toBe("");
  });

  it("does not silently collapse to prod when the basename is 'hub-' (trailing dash)", () => {
    // Stripping the "hub-" prefix from "hub-" yields "" — without the
    // explicit fallback this would land in the same branch as the canonical
    // "hub" basename and the dev install would collide with prod's unit.
    // Pinned: degrade to the verbatim basename instead.
    expect(deriveServiceSuffix("hub-")).toBe("hub-");
  });
});
