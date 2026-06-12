// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatDescriptionInfo } from "../chat-description-info.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;
const writeText = vi.fn<(text: string) => Promise<void>>();

function render(ui: ReactElement): void {
  act(() => {
    root?.render(<MemoryRouter initialEntries={["/start"]}>{ui}</MemoryRouter>);
  });
}

function flush(): Promise<void> {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < 25; i++) {
    try {
      assertion();
      return;
    } catch (err) {
      lastErr = err;
    }
    await flush();
  }
  throw lastErr;
}

function trigger(): HTMLButtonElement {
  const btn = container?.querySelector<HTMLButtonElement>("button");
  if (!btn) throw new Error("trigger not found");
  return btn;
}

function card(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="dialog"]');
}

async function openCard(): Promise<HTMLElement> {
  await act(async () => {
    trigger().click();
    await Promise.resolve();
  });
  await flush();
  const el = card();
  if (!el) throw new Error("card did not open");
  return el;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1400 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = "";
});

const DESCRIPTION = "Reviewing PR 987 — chat header description popover, gates green, awaiting review.";

describe("ChatDescriptionInfo", () => {
  it("renders a labelled trigger and stays closed until activated", async () => {
    render(<ChatDescriptionInfo description={DESCRIPTION} />);
    await flush();
    expect(trigger().getAttribute("aria-label")).toBe("View chat description");
    expect(card()).toBeNull();
  });

  it("opens a Description card with the full text on click", async () => {
    render(<ChatDescriptionInfo description={DESCRIPTION} />);
    await flush();
    const el = await openCard();
    await waitFor(() => {
      expect(el.textContent).toContain("Description");
      expect(el.textContent).toContain(DESCRIPTION);
    });
  });

  it("copies the description and flips the button to Copied", async () => {
    render(<ChatDescriptionInfo description={DESCRIPTION} />);
    await flush();
    const el = await openCard();
    const copyBtn = [...el.querySelectorAll("button")].find((b) => b.textContent?.includes("Copy"));
    if (!copyBtn) throw new Error("copy button not found");
    await act(async () => {
      copyBtn.click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(DESCRIPTION);
    await waitFor(() => {
      expect(el.textContent).toContain("Copied");
    });
  });

  it("closes on Escape", async () => {
    render(<ChatDescriptionInfo description={DESCRIPTION} />);
    await flush();
    await openCard();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      await Promise.resolve();
    });
    await flush();
    expect(card()).toBeNull();
  });
});
