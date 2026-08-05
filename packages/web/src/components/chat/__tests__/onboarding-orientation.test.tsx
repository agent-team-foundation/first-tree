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
    root.render(
      <OnboardingOrientation
        completed={false}
        continuing={false}
        targetAgentName="Nova"
        onContinue={vi.fn()}
        {...props}
      />,
    );
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
  it("shows the selected video, persistent chapter list, and header skip plus start actions", async () => {
    const onContinue = vi.fn();
    const { container } = await renderOrientation({ onContinue });

    expect(container.querySelector('[data-onboarding-orientation="pending"]')).not.toBeNull();
    expect(container.querySelectorAll("[data-orientation-chapter]")).toHaveLength(3);
    expect(container.textContent).toContain("Watch the short tours");
    expect(container.textContent).toContain("Context Tree");
    expect(container.textContent).toContain("GitHub automation");
    expect(container.textContent).not.toContain("Video placeholder");
    expect(container.textContent).not.toContain("Transcript");
    expect(container.querySelector("video")?.autoplay).toBe(false);

    const skipButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Skip intro",
    );
    await click(skipButton ?? null);
    expect(onContinue).toHaveBeenCalledTimes(1);

    const startButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Start with Nova",
    );
    await click(startButton ?? null);
    expect(onContinue).toHaveBeenCalledTimes(2);
  });

  it("shows the chapter summary inside the failed-video recovery state", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
    const { container } = await renderOrientation();
    expect(container.querySelector("[data-onboarding-orientation-video-error]")).toBeNull();

    const video = container.querySelector("video");
    await act(async () => {
      video?.dispatchEvent(new Event("error"));
    });
    const errorState = container.querySelector("[data-onboarding-orientation-video-error]");
    expect(errorState?.textContent).toContain("This video couldn’t load");
    expect(errorState?.textContent).toContain("The right agents join as the work unfolds");
    expect(errorState?.textContent).not.toContain("Transcript");

    const tryAgain = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Try again",
    );
    await click(tryAgain ?? null);
    expect(container.querySelector("[data-onboarding-orientation-video-error]")).toBeNull();
  });

  it("plays a chapter when its persistent playlist item is clicked and marks it watched on completion", async () => {
    const onContinue = vi.fn();
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const { container } = await renderOrientation({ onContinue });
    const multiAgent = [...container.querySelectorAll<HTMLButtonElement>("[data-orientation-chapter]")].find((button) =>
      button.textContent?.includes("Multi-agent collaboration"),
    );

    await click(multiAgent ?? null);
    expect(play).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll("[data-orientation-chapter]")).toHaveLength(3);
    expect(container.textContent).toContain("The right agents join as the work unfolds");
    const video = container.querySelector("video");
    expect(video?.getAttribute("poster")).toBe("/onboarding/orientation/stills/multi-agent-poster.png");
    expect(video?.querySelector("source")?.getAttribute("src")).toBe("/onboarding/orientation/multi-agent.mp4");
    const captions = video?.querySelector("track");
    expect(captions?.getAttribute("src")).toBe("/onboarding/orientation/multi-agent.vtt");
    expect(captions?.hasAttribute("default")).toBe(false);
    expect(container.textContent).not.toContain("Transcript");
    expect(container.textContent).not.toContain("Choose another chapter");

    await act(async () => {
      video?.dispatchEvent(new Event("ended"));
    });
    expect(multiAgent?.dataset.orientationChapterStatus).toBe("watched");

    const startButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Start with Nova",
    );
    await click(startButton ?? null);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("plays newly mounted chapter media from the click and exposes recovery when playback is blocked", async () => {
    const play = vi
      .spyOn(HTMLMediaElement.prototype, "play")
      .mockRejectedValueOnce(new DOMException("Playback blocked", "NotAllowedError"))
      .mockResolvedValue(undefined);
    const { container } = await renderOrientation();
    const contextTree = [...container.querySelectorAll<HTMLButtonElement>("[data-orientation-chapter]")].find(
      (button) => button.textContent?.includes("Context Tree"),
    );

    await click(contextTree ?? null);
    expect(play).toHaveBeenCalledTimes(1);
    expect(container.querySelector("video")?.dataset.onboardingOrientationVideo).toBe("context-tree");

    const prompt = container.querySelector("[data-onboarding-orientation-playback-prompt]");
    expect(prompt?.textContent).toContain("Press play to watch this chapter");
    const playChapter = [...(prompt?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.trim() === "Play chapter",
    );
    await click(playChapter ?? null);
    expect(play).toHaveBeenCalledTimes(2);
    expect(container.querySelector("[data-onboarding-orientation-playback-prompt]")).toBeNull();
  });

  it("acknowledges completion after all three chapters finish", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    const { container } = await renderOrientation();
    const chapterButtons = [...container.querySelectorAll<HTMLButtonElement>("[data-orientation-chapter]")];

    for (const chapterButton of chapterButtons) {
      await click(chapterButton);
      await act(async () => {
        container.querySelector("video")?.dispatchEvent(new Event("ended"));
      });
    }

    expect(container.textContent).toContain("Tour complete. Start whenever you’re ready.");
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "nearest" });
  });

  it("wraps an unbroken long agent name inside the start action", async () => {
    const { container } = await renderOrientation({ targetAgentName: "A".repeat(231) });
    const startButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.startsWith("Start with A"),
    );

    expect(startButton?.style.overflowWrap).toBe("anywhere");
    expect(startButton?.className).toContain("h-auto");
    expect(startButton?.className).toContain("whitespace-normal");
  });

  it("connects the Context Tree chapter to narrated media with opt-in captions", async () => {
    const { container } = await renderOrientation();
    const contextTree = [...container.querySelectorAll<HTMLButtonElement>("[data-orientation-chapter]")].find(
      (button) => button.textContent?.includes("Context Tree"),
    );

    await click(contextTree ?? null);
    expect(container.textContent).toContain("Read, work, review, update—then start smarter");
    const video = container.querySelector("video");
    expect(video?.getAttribute("poster")).toBe("/onboarding/orientation/stills/context-tree-poster.png");
    expect(video?.querySelector("source")?.getAttribute("src")).toBe("/onboarding/orientation/context-tree.mp4");
    const captions = video?.querySelector("track");
    expect(captions?.getAttribute("src")).toBe("/onboarding/orientation/context-tree.vtt");
    expect(captions?.hasAttribute("default")).toBe(false);
    expect(container.textContent).not.toContain("Transcript");
  });

  it("connects the GitHub chapter to narrated automation media with opt-in captions", async () => {
    const { container } = await renderOrientation();
    const github = [...container.querySelectorAll<HTMLButtonElement>("[data-orientation-chapter]")].find((button) =>
      button.textContent?.includes("GitHub automation"),
    );

    await click(github ?? null);
    expect(container.textContent).toContain("Issue-to-PR work stays connected in one Chat");
    const video = container.querySelector("video");
    expect(video?.getAttribute("poster")).toBe("/onboarding/orientation/stills/github-poster.png");
    expect(video?.querySelector("source")?.getAttribute("src")).toBe("/onboarding/orientation/github.mp4");
    const captions = video?.querySelector("track");
    expect(captions?.getAttribute("src")).toBe("/onboarding/orientation/github.vtt");
    expect(captions?.hasAttribute("default")).toBe(false);
    expect(container.textContent).not.toContain("Transcript");
  });

  it("collapses completed Orientation while keeping an explicit review path", async () => {
    const onContinue = vi.fn();
    const { container } = await renderOrientation({ completed: true, onContinue });

    expect(container.querySelector('[data-onboarding-orientation="completed"]')).not.toBeNull();
    expect(container.querySelectorAll("[data-orientation-chapter]")).toHaveLength(0);
    expect(container.textContent).not.toContain("Start with Nova");

    const review = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Watch");
    await click(review ?? null);
    expect(container.querySelectorAll("[data-orientation-chapter]")).toHaveLength(3);
    expect(onContinue).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Start with Nova");
    expect(container.textContent).not.toContain("Skip intro");
    expect(container.textContent).toContain("Replay any chapter");

    const close = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Close tour",
    );
    await click(close ?? null);
    expect(container.querySelector('[data-onboarding-orientation="completed"]')).not.toBeNull();
  });
});
