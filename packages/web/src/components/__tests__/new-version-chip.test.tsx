// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDomHarness, type DomHarness } from "../../test-utils/dom-harness.js";
import { NewVersionChip } from "../new-version-chip.js";

/**
 * Presentational tests for the topbar new-version chip. Detection lives in
 * `useNewVersionAvailable` (covered by use-version-check tests); here we pin
 * the render contract that the narrow-layout fix depends on — the chip is a
 * pure function of its props, so it can be mounted (and polled-for) at every
 * breakpoint rather than only inside the hideable brand cluster.
 */
describe("NewVersionChip", () => {
  let h: DomHarness;
  beforeEach(() => {
    h = createDomHarness();
  });
  afterEach(() => h.cleanup());

  it("renders nothing when no new version is available", () => {
    h.render(<NewVersionChip show={false} />);
    expect(h.container.querySelector("button")).toBeNull();
  });

  it("renders a labelled refresh button (full) when a new version is available", () => {
    h.render(<NewVersionChip show={true} />);
    const btn = h.container.querySelector("button");
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toContain("New version");
    expect(btn?.getAttribute("aria-label")?.toLowerCase()).toContain("refresh");
  });

  it("renders an icon-only button (compact) with no visible text, still labelled for a11y", () => {
    h.render(<NewVersionChip show={true} compact />);
    const btn = h.container.querySelector("button");
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toBe("");
    expect(btn?.getAttribute("aria-label")?.toLowerCase()).toContain("refresh");
  });
});
