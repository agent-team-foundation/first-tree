// @vitest-environment happy-dom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OnboardingOrientation } from "../onboarding-orientation.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function renderOrientation(
  props: Partial<ComponentProps<typeof OnboardingOrientation>> = {},
): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<OnboardingOrientation completed={false} continuing={false} onContinue={vi.fn()} {...props} />);
  });
  return { container, root };
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("OnboardingOrientation", () => {
  it("offers the available chapter and one global skip action", async () => {
    const onContinue = vi.fn();
    const { container } = await renderOrientation({ onContinue });

    expect(container.querySelector('[data-onboarding-orientation="pending"]')).not.toBeNull();
    expect(container.querySelectorAll("[data-orientation-chapter]")).toHaveLength(1);
    expect(container.textContent).toContain("Watch a short product tour");
    expect(container.textContent).not.toContain("Context Tree");
    expect(container.textContent).not.toContain("GitHub automation");
    expect(container.textContent).not.toContain("Video placeholder");
    expect(container.textContent).not.toContain("Read transcript");

    const skip = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Skip introduction and start",
    );
    await click(skip ?? null);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("lets the user inspect any chapter, then explicitly start their task", async () => {
    const onContinue = vi.fn();
    const { container } = await renderOrientation({ onContinue });
    const multiAgent = [...container.querySelectorAll<HTMLButtonElement>("[data-orientation-chapter]")].find((button) =>
      button.textContent?.includes("Multi-agent collaboration"),
    );

    await click(multiAgent ?? null);
    expect(container.querySelectorAll("[data-orientation-chapter]")).toHaveLength(0);
    expect(container.textContent).toContain("The right agents join as the work unfolds");
    const video = container.querySelector("video");
    expect(video?.getAttribute("poster")).toBe("/onboarding/orientation/stills/multi-agent-poster.png");
    expect(video?.querySelector("source")?.getAttribute("src")).toBe("/onboarding/orientation/multi-agent.mp4");
    expect(video?.querySelector("track")?.getAttribute("src")).toBe("/onboarding/orientation/multi-agent.vtt");
    expect(container.textContent).toContain("Read transcript");
    expect(container.textContent).toContain("Choose another chapter");

    const start = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Start my first task",
    );
    await click(start ?? null);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("collapses completed Orientation while keeping an explicit review path", async () => {
    const onContinue = vi.fn();
    const { container } = await renderOrientation({ completed: true, onContinue });

    expect(container.querySelector('[data-onboarding-orientation="completed"]')).not.toBeNull();
    expect(container.querySelectorAll("[data-orientation-chapter]")).toHaveLength(0);
    expect(container.textContent).not.toContain("Skip introduction and start");

    const review = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Watch again",
    );
    await click(review ?? null);
    expect(container.querySelectorAll("[data-orientation-chapter]")).toHaveLength(1);
    expect(onContinue).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Start my first task");
  });
});
