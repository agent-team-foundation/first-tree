// @vitest-environment happy-dom

import type { ChatEngagementView, ChatSource } from "@first-tree/shared";
import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilterPopover, originLabel } from "../filter-popover.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The popover fetches the org roster for the Participants picker; drive it from a
// mutable result (reset in `beforeEach`) so tests can exercise the loaded and
// error states without a QueryClient. `mock`-prefixed so vitest's hoisted
// `vi.mock` factory may reference it.
type MockAgentsResult = {
  data: { items: Array<{ uuid: string; displayName: string }> } | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
};
const mockAgentsDefault: MockAgentsResult = {
  data: {
    items: [
      { uuid: "agent-1", displayName: "Nova" },
      { uuid: "agent-2", displayName: "Design Critique" },
    ],
  },
  isLoading: false,
  isError: false,
  refetch: () => {},
};
let mockAgentsResult: MockAgentsResult = mockAgentsDefault;
vi.mock("../../../../lib/use-org-agents.js", () => ({
  useOrgAgents: () => mockAgentsResult,
}));

let root: Root | null = null;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderDom(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(element);
  });
  await flush();
  return container;
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

function inputByLabel(label: string, type: "checkbox" | "radio"): HTMLInputElement {
  const labels = [...document.body.querySelectorAll("label")];
  const row = labels.find((el) => el.textContent?.includes(label));
  const input = row?.querySelector<HTMLInputElement>(`input[type="${type}"]`);
  if (!input) throw new Error(`Missing ${type} ${label}`);
  return input;
}
const checkboxByLabel = (label: string): HTMLInputElement => inputByLabel(label, "checkbox");
const radioByLabel = (label: string): HTMLInputElement => inputByLabel(label, "radio");

function StatefulFilter({
  onOriginChange,
  onEngagementChange,
  onParticipantsChange,
  onResetAll,
}: {
  onOriginChange: (origin: ReadonlyArray<ChatSource>) => void;
  onEngagementChange: (engagement: ChatEngagementView) => void;
  onParticipantsChange: (participants: ReadonlyArray<string>) => void;
  onResetAll: () => void;
}) {
  const [origin, setOrigin] = useState<ChatSource[]>(["github", "agent"]);
  const [engagement, setEngagement] = useState<ChatEngagementView>("archived");
  const [participants, setParticipants] = useState<string[]>([]);
  return (
    <FilterPopover
      origin={origin}
      onOriginChange={(next) => {
        setOrigin([...next]);
        onOriginChange(next);
      }}
      engagement={engagement}
      onEngagementChange={(next) => {
        setEngagement(next);
        onEngagementChange(next);
      }}
      participants={participants}
      onParticipantsChange={(next) => {
        setParticipants([...next]);
        onParticipantsChange(next);
      }}
      onResetAll={() => {
        setOrigin([]);
        setEngagement("active");
        setParticipants([]);
        onResetAll();
      }}
      activeCount={(origin.length > 0 ? 1 : 0) + (participants.length > 0 ? 1 : 0) + (engagement !== "active" ? 1 : 0)}
    />
  );
}

beforeEach(() => {
  document.body.innerHTML = "";
  mockAgentsResult = mockAgentsDefault;
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  root = null;
  document.body.innerHTML = "";
});

describe("FilterPopover", () => {
  it("labels unknown origins defensively", () => {
    expect(originLabel("github")).toBe("GitHub");
    expect(originLabel("agent")).toBe("Agent");
    expect(originLabel("future" as ChatSource)).toBe("future");
  });

  it("status is exclusive; source defaults to all with no zero-source state; reset + done", async () => {
    const onOriginChange = vi.fn();
    const onEngagementChange = vi.fn();
    const onParticipantsChange = vi.fn();
    const onResetAll = vi.fn();
    const container = await renderDom(
      <StatefulFilter
        onOriginChange={onOriginChange}
        onEngagementChange={onEngagementChange}
        onParticipantsChange={onParticipantsChange}
        onResetAll={onResetAll}
      />,
    );

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Filter"]');
    // Badge counts DIMENSIONS, not values: narrowed Source (1) + non-default
    // Status (1) = 2, regardless of how many individual sources are picked.
    expect(trigger?.textContent).toContain("2");
    await click(trigger ?? null);

    expect(document.body.textContent).toContain("Status");
    expect(document.body.textContent).toContain("Source");
    // Status is a radio group: archived selected, the others not.
    expect(radioByLabel("Archived").checked).toBe(true);
    expect(radioByLabel("Active").checked).toBe(false);
    expect(radioByLabel("All").checked).toBe(false);
    // Source: the narrowed subset (github + agent) is checked, Human is not.
    expect(checkboxByLabel("GitHub").checked).toBe(true);
    expect(checkboxByLabel("Agent").checked).toBe(true);
    expect(checkboxByLabel("Human").checked).toBe(false);

    // Status is EXCLUSIVE — picking Active sets engagement to exactly "active".
    await click(radioByLabel("Active"));
    expect(onEngagementChange).toHaveBeenLastCalledWith("active");
    expect(radioByLabel("Active").checked).toBe(true);
    expect(radioByLabel("Archived").checked).toBe(false);

    // Checking the missing source completes the full set → normalizes to the
    // unrestricted (empty) wire so "all sources" is not active narrowing.
    await click(checkboxByLabel("Human"));
    expect(onOriginChange).toHaveBeenLastCalledWith([]);
    expect(checkboxByLabel("Human").checked).toBe(true);
    expect(checkboxByLabel("GitHub").checked).toBe(true);

    // Narrow again by unchecking down toward a single source.
    await click(checkboxByLabel("Human"));
    expect(onOriginChange).toHaveBeenLastCalledWith(["github", "agent"]);
    await click(checkboxByLabel("Agent"));
    expect(onOriginChange).toHaveBeenLastCalledWith(["github"]);

    // The last checked source CANNOT be removed — no zero-source state.
    onOriginChange.mockClear();
    await click(checkboxByLabel("GitHub"));
    expect(onOriginChange).not.toHaveBeenCalled();
    expect(checkboxByLabel("GitHub").checked).toBe(true);

    // Per-section Source reset returns to unrestricted (all checked).
    await click([...document.body.querySelectorAll("button")].find((b) => b.textContent === "Reset") ?? null);
    expect(onOriginChange).toHaveBeenLastCalledWith([]);
    expect(checkboxByLabel("Human").checked).toBe(true);

    // Participants OR-picker: the org roster renders; the default is no
    // constraint (every box unchecked). Toggling an agent adds it to `with`.
    expect(document.body.textContent).toContain("Participants");
    expect(checkboxByLabel("Nova").checked).toBe(false);
    await click(checkboxByLabel("Nova"));
    expect(onParticipantsChange).toHaveBeenLastCalledWith(["agent-1"]);
    expect(checkboxByLabel("Nova").checked).toBe(true);

    // The footer "Reset" is the LAST such button — the per-section Source /
    // Participants "Reset" links share the label and render before it.
    await click([...document.body.querySelectorAll("button")].filter((b) => b.textContent === "Reset").at(-1) ?? null);
    expect(onResetAll).toHaveBeenCalledTimes(1);
    await click([...document.body.querySelectorAll("button")].find((b) => b.textContent === "Done") ?? null);
    expect(document.body.textContent).not.toContain("Source");
  });

  it("surfaces an error + retry when the participants roster fails to load", async () => {
    // A failed roster load must NOT read as an empty "No people to filter by."
    const refetch = vi.fn();
    mockAgentsResult = { data: undefined, isLoading: false, isError: true, refetch };
    const noop = (): void => {};
    const container = await renderDom(
      <StatefulFilter onOriginChange={noop} onEngagementChange={noop} onParticipantsChange={noop} onResetAll={noop} />,
    );
    await click(container.querySelector('button[aria-label="Filter"]'));

    expect(document.body.textContent).toContain("Couldn't load people.");
    expect(document.body.textContent).not.toContain("No people to filter by.");
    const retry = [...document.body.querySelectorAll("button")].find((b) => b.textContent === "Retry");
    expect(retry).toBeTruthy();
    await click(retry ?? null);
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
