// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDomHarness, type DomHarness } from "../../../test-utils/dom-harness.js";
import { MobileCurrentStateCard } from "../current-state-card.js";

describe("MobileCurrentStateCard", () => {
  let harness: DomHarness;

  beforeEach(() => {
    harness = createDomHarness();
  });
  afterEach(() => harness.cleanup());

  it("renders a short summary in full and preserves its Markdown evidence", () => {
    harness.render(
      <MobileCurrentStateCard
        description={"**Decision:** ship the staged rollout.\n\n- Checks are green"}
        descriptionUpdatedAt="2026-07-23T16:00:00.000Z"
        lastReadAt="2026-07-23T17:00:00.000Z"
      />,
    );

    const card = harness.container.querySelector("[data-mobile-current-state]");
    expect(card?.getAttribute("aria-label")).toBe("Current state");
    expect(card?.querySelector("strong")?.textContent).toBe("Decision:");
    expect(card?.textContent).toContain("Checks are green");
    expect(card?.textContent).not.toContain("Show more");
  });

  it("clamps a long summary to four lines and expands inline without a nested scroll surface", async () => {
    const longSummary = [
      "The launch candidate is deployed to staging.",
      "All smoke tests are green.",
      "The migration rehearsal completed.",
      "Support has the runbook.",
      "Production rollout still needs final approval.",
    ].join("\n");
    harness.render(
      <MobileCurrentStateCard
        description={longSummary}
        descriptionUpdatedAt="2026-07-23T18:00:00.000Z"
        lastReadAt="2026-07-23T17:00:00.000Z"
      />,
    );
    await setMeasuredHeight(harness, 120);

    const card = harness.container.querySelector<HTMLElement>("[data-mobile-current-state]");
    expect(card?.querySelector("[data-mobile-current-state-collapsed]")?.getAttribute("style")).toContain(
      "overflow: hidden",
    );
    expect(card?.className).not.toContain("overflow");
    expect(card?.textContent).toContain("Updated");

    const toggle = card?.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
    await act(async () => toggle?.click());
    expect(card?.querySelector('button[aria-expanded="true"]')?.textContent).toContain("Show less");
    expect(card?.querySelector("[data-mobile-current-state-collapsed]")).toBeNull();
  });

  it("offers expansion when a sub-240-character CJK paragraph wraps beyond four rendered lines", async () => {
    const wrappedCjk =
      "移动端工作列表需要在窄屏上保持清晰稳定，让用户不用进入详情就能判断当前状态、失败原因、待处理请求以及下一步行动。".repeat(
        2,
      );
    expect(wrappedCjk.length).toBeLessThan(240);

    harness.render(
      <MobileCurrentStateCard
        description={wrappedCjk}
        descriptionUpdatedAt="2026-07-23T18:00:00.000Z"
        lastReadAt="2026-07-23T17:00:00.000Z"
      />,
    );
    await setMeasuredHeight(harness, 120);

    const card = harness.container.querySelector<HTMLElement>("[data-mobile-current-state]");
    expect(card?.querySelector('button[aria-expanded="false"]')?.textContent).toContain("Show more");
    expect(card?.querySelector("[data-mobile-current-state-collapsed]")?.getAttribute("data-line-clamp")).toBe("4");
  });

  it("renders nothing when no summary exists", () => {
    harness.render(<MobileCurrentStateCard description={null} descriptionUpdatedAt={null} lastReadAt={null} />);
    expect(harness.container.querySelector("[data-mobile-current-state]")).toBeNull();
  });
});

async function setMeasuredHeight(harness: DomHarness, scrollHeight: number): Promise<void> {
  const measurement = harness.container.querySelector<HTMLElement>("[data-mobile-current-state-measure]");
  if (!measurement) throw new Error("Missing Current state measurement surface");
  Object.defineProperty(measurement, "scrollHeight", { configurable: true, value: scrollHeight });
  await act(async () => window.dispatchEvent(new Event("resize")));
}
