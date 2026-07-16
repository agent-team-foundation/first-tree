// @vitest-environment happy-dom

import type { ChatEngagementView, ChatSource } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilterPopover, originLabel } from "../filter-popover.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The Participants picker is SEARCH-driven: typing keys `useOrgAgentsSearch`.
// - the debounce is a passthrough in tests so results settle synchronously;
// - `useOrgAgentsSearch` returns roster entries whose displayName matches the
//   query (empty query → no items, mirroring the search-only "no list" design);
// - the name map resolves selected-chip labels.
// `mockSearchOverride` (mock-prefixed so the hoisted factory may read it) lets a
// test force an in-flight state.
// Debounce is a passthrough by default (results settle synchronously); a test
// forces a lag — the debounced value trailing the raw input — via `mockDebounceLag`.
let mockDebounceLag: string | null = null;
vi.mock("../../../../lib/use-debounced-value.js", () => ({
  useDebouncedValue: (value: string) => (mockDebounceLag === null ? value : mockDebounceLag),
}));
// The identity map is mutable so a test can simulate a rename (the authoritative
// roster refreshing) and prove it supersedes a cached search label. Unresolved
// ids return the raw id, mirroring the real `useAgentNameMap`.
const defaultNameResolve = (id: string): string =>
  id === "agent-1" ? "Nova" : id === "agent-2" ? "Design Critique" : id;
let mockNameResolve: (id: string) => string = defaultNameResolve;
vi.mock("../../../../lib/use-agent-name-map.js", () => ({
  useAgentNameMap: () => (id: string) => mockNameResolve(id),
}));
let mockSearchOverride: {
  data: { items: Array<{ uuid: string; displayName: string }> } | undefined;
  isFetching: boolean;
} | null = null;
vi.mock("../../../../lib/use-org-agents.js", () => ({
  useOrgAgentsSearch: (query: string) => {
    if (mockSearchOverride) return mockSearchOverride;
    const roster = [
      { uuid: "agent-1", displayName: "Nova" },
      { uuid: "agent-2", displayName: "Design Critique" },
      // Past the identity-map cap: the name map mock returns the raw id for this
      // one, so only the search-fed name cache can label it.
      { uuid: "agent-3", displayName: "Zara" },
    ];
    const q = query.trim().toLowerCase();
    const items = q.length === 0 ? [] : roster.filter((a) => a.displayName.toLowerCase().includes(q));
    return { data: { items }, isFetching: false };
  },
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
  // The participant-name cache is a react-query entry, so each case renders
  // under a fresh client — an org switch / logout that calls `queryClient.clear()`
  // is modeled as a new client (the cache is scoped to it, not a module global).
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  await act(async () => {
    root?.render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
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

// Set a React controlled-input value via the native setter (bypasses React's
// value tracker) then dispatch input, so onChange fires with the new value.
async function typeSearch(value: string): Promise<void> {
  const input = document.body.querySelector<HTMLInputElement>('input[aria-label="Search participants"]');
  if (!input) throw new Error("Missing participants search input");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
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
  initialParticipants = [],
}: {
  onOriginChange: (origin: ReadonlyArray<ChatSource>) => void;
  onEngagementChange: (engagement: ChatEngagementView) => void;
  onParticipantsChange: (participants: ReadonlyArray<string>) => void;
  onResetAll: () => void;
  initialParticipants?: string[];
}) {
  const [origin, setOrigin] = useState<ChatSource[]>(["github", "gitlab", "agent"]);
  const [engagement, setEngagement] = useState<ChatEngagementView>("archived");
  const [participants, setParticipants] = useState<string[]>(initialParticipants);
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
  mockSearchOverride = null;
  mockDebounceLag = null;
  mockNameResolve = defaultNameResolve;
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
    expect(originLabel("gitlab")).toBe("GitLab");
    expect(originLabel("agent")).toBe("Agent");
    expect(originLabel("future" as ChatSource)).toBe("future");
  });

  it("status is exclusive; source defaults to all with no zero-source state; participants search + reset", async () => {
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
    // Source: the narrowed provider subset is checked, Human is not.
    expect(checkboxByLabel("GitHub").checked).toBe(true);
    expect(checkboxByLabel("GitLab").checked).toBe(true);
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
    expect(onOriginChange).toHaveBeenLastCalledWith(["github", "gitlab", "agent"]);
    await click(checkboxByLabel("Agent"));
    expect(onOriginChange).toHaveBeenLastCalledWith(["github", "gitlab"]);
    await click(checkboxByLabel("GitLab"));
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

    // Participants is SEARCH-only: no roster is dumped until you type.
    expect(document.body.textContent).toContain("Participants");
    expect(document.body.textContent).toContain("Type to search people.");
    expect(document.body.textContent).not.toContain("Nova");
    await typeSearch("nova");
    // The match renders as a toggle; picking it adds the agent to `with`.
    expect(checkboxByLabel("Nova").checked).toBe(false);
    await click(checkboxByLabel("Nova"));
    expect(onParticipantsChange).toHaveBeenLastCalledWith(["agent-1"]);
    expect(checkboxByLabel("Nova").checked).toBe(true);

    // The footer "Reset" is the LAST such button — the per-section Participants
    // "Reset" link shares the label and renders before it.
    await click([...document.body.querySelectorAll("button")].filter((b) => b.textContent === "Reset").at(-1) ?? null);
    expect(onResetAll).toHaveBeenCalledTimes(1);
    await click([...document.body.querySelectorAll("button")].find((b) => b.textContent === "Done") ?? null);
    expect(document.body.textContent).not.toContain("Source");
  });

  it("is search-only: empty query hints, typing filters, no match reports it", async () => {
    const noop = (): void => {};
    const container = await renderDom(
      <StatefulFilter onOriginChange={noop} onEngagementChange={noop} onParticipantsChange={noop} onResetAll={noop} />,
    );
    await click(container.querySelector('button[aria-label="Filter"]'));

    // No roster dump — just a hint until the user types.
    expect(document.body.textContent).toContain("Type to search people.");
    expect(document.body.textContent).not.toContain("Nova");
    expect(document.body.textContent).not.toContain("Design Critique");

    await typeSearch("des");
    expect(document.body.textContent).toContain("Design Critique");
    expect(document.body.textContent).not.toContain("Nova");

    await typeSearch("zzz");
    expect(document.body.textContent).toContain("No people match");
    expect(document.body.textContent).not.toContain("Design Critique");
  });

  it("shows an in-flight query as Searching…", async () => {
    mockSearchOverride = { data: undefined, isFetching: true };
    const noop = (): void => {};
    const container = await renderDom(
      <StatefulFilter onOriginChange={noop} onEngagementChange={noop} onParticipantsChange={noop} onResetAll={noop} />,
    );
    await click(container.querySelector('button[aria-label="Filter"]'));
    await typeSearch("no");
    expect(document.body.textContent).toContain("Searching…");
  });

  it("shows a selected participant as a removable chip and removes it", async () => {
    const onParticipantsChange = vi.fn();
    const noop = (): void => {};
    const container = await renderDom(
      <StatefulFilter
        onOriginChange={noop}
        onEngagementChange={noop}
        onParticipantsChange={onParticipantsChange}
        onResetAll={noop}
      />,
    );
    await click(container.querySelector('button[aria-label="Filter"]'));
    await typeSearch("nova");
    await click(checkboxByLabel("Nova"));
    expect(onParticipantsChange).toHaveBeenLastCalledWith(["agent-1"]);

    // The chip persists INDEPENDENTLY of the results: searching a different term
    // (Nova is no longer a match) keeps the removable chip, and its name comes
    // from the pick — proving chips don't depend on the visible result rows.
    await typeSearch("zzz");
    expect(document.body.textContent).toContain("No people match");
    const chip = [...document.body.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "Remove Nova",
    );
    expect(chip).toBeTruthy();
    await click(chip ?? null);
    expect(onParticipantsChange).toHaveBeenLastCalledWith([]);
  });

  it("emits ?with= in canonical (sorted) order regardless of pick order", async () => {
    const onParticipantsChange = vi.fn();
    const noop = (): void => {};
    const container = await renderDom(
      <StatefulFilter
        onOriginChange={noop}
        onEngagementChange={noop}
        onParticipantsChange={onParticipantsChange}
        onResetAll={noop}
      />,
    );
    await click(container.querySelector('button[aria-label="Filter"]'));
    // Pick Design Critique (agent-2) first, then Nova (agent-1) — the emitted set
    // must be sorted, not insertion-ordered, so one `?with=` key serves both.
    await typeSearch("design");
    await click(checkboxByLabel("Design Critique"));
    expect(onParticipantsChange).toHaveBeenLastCalledWith(["agent-2"]);
    await typeSearch("nova");
    await click(checkboxByLabel("Nova"));
    expect(onParticipantsChange).toHaveBeenLastCalledWith(["agent-1", "agent-2"]);
  });

  it("keeps Searching… (not No match) while the debounce trails a new term", async () => {
    mockDebounceLag = "zz"; // debounced trails the raw input
    const noop = (): void => {};
    const container = await renderDom(
      <StatefulFilter onOriginChange={noop} onEngagementChange={noop} onParticipantsChange={noop} onResetAll={noop} />,
    );
    await click(container.querySelector('button[aria-label="Filter"]'));
    await typeSearch("zzz"); // raw "zzz" !== debounced "zz" → still settling
    expect(document.body.textContent).toContain("Searching…");
    expect(document.body.textContent).not.toContain("No people match");
  });

  it("keeps a stale result visible but non-toggleable while a newer term settles", async () => {
    const noop = (): void => {};
    const container = await renderDom(
      <StatefulFilter onOriginChange={noop} onEngagementChange={noop} onParticipantsChange={noop} onResetAll={noop} />,
    );
    await click(container.querySelector('button[aria-label="Filter"]'));
    await typeSearch("nova");
    expect(checkboxByLabel("Nova").disabled).toBe(false);

    // Type a NEW term but freeze the debounce behind it: the old Nova row is now
    // stale (input says "design", results still reflect "nova"). It stays visible
    // but disabled so a pick can't land on a query the user no longer sees.
    mockDebounceLag = "nova";
    await typeSearch("design");
    expect(document.body.textContent).toContain("Nova");
    expect(checkboxByLabel("Nova").disabled).toBe(true);
  });

  it("retains a searched name past the identity-map cap on its chip across close/reopen", async () => {
    const noop = (): void => {};
    const container = await renderDom(
      <StatefulFilter onOriginChange={noop} onEngagementChange={noop} onParticipantsChange={noop} onResetAll={noop} />,
    );
    const openFilter = (): Promise<void> => click(container.querySelector('button[aria-label="Filter"]'));
    await openFilter();
    // Zara is absent from the identity-map mock (it returns her raw id), so only
    // the search-fed cache can name her chip.
    await typeSearch("zara");
    await click(checkboxByLabel("Zara"));
    expect(document.body.textContent).toContain("@Zara");

    // Close the popover (the section unmounts) then reopen — the chip must still
    // read "@Zara", not the raw uuid, because the name cache outlives the panel.
    await click([...document.body.querySelectorAll("button")].find((b) => b.textContent === "Done") ?? null);
    await openFilter();
    expect(document.body.textContent).toContain("@Zara");
    expect(document.body.textContent).not.toContain("agent-3");
  });

  it("lets a refreshed identity-map name supersede a cached search label", async () => {
    const noop = (): void => {};
    const container = await renderDom(
      <StatefulFilter onOriginChange={noop} onEngagementChange={noop} onParticipantsChange={noop} onResetAll={noop} />,
    );
    await click(container.querySelector('button[aria-label="Filter"]'));
    await typeSearch("nova");
    await click(checkboxByLabel("Nova")); // caches "Nova"

    // A rename lands on the authoritative roster (which polls / invalidates);
    // the chip must show the fresh name, not the cached one.
    mockNameResolve = (id) => (id === "agent-1" ? "Nova (renamed)" : defaultNameResolve(id));
    await typeSearch(""); // any state change re-renders the section
    const renamed = [...document.body.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "Remove Nova (renamed)",
    );
    expect(renamed).toBeTruthy();
    const stale = [...document.body.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "Remove Nova",
    );
    expect(stale).toBeFalsy();
  });

  it("scopes cached search labels to the react-query client — a fresh scope starts empty", async () => {
    const noop = (): void => {};
    // Scope A (client A): search + select Zara → her name is cached in A.
    const a = await renderDom(
      <StatefulFilter onOriginChange={noop} onEngagementChange={noop} onParticipantsChange={noop} onResetAll={noop} />,
    );
    await click(a.querySelector('button[aria-label="Filter"]'));
    await typeSearch("zara");
    await click(checkboxByLabel("Zara"));
    expect(document.body.textContent).toContain("@Zara");
    await act(async () => root?.unmount());
    root = null;
    document.body.innerHTML = "";

    // Scope B: a fresh client — as after an org switch / logout, where the app
    // calls `queryClient.clear()`, so the cache (a react-query entry) is gone —
    // with Zara pre-selected via URL but never searched here. Her chip must fall
    // back to the raw uuid, never leaking scope A's cached "Zara".
    const b = await renderDom(
      <StatefulFilter
        onOriginChange={noop}
        onEngagementChange={noop}
        onParticipantsChange={noop}
        onResetAll={noop}
        initialParticipants={["agent-3"]}
      />,
    );
    await click(b.querySelector('button[aria-label="Filter"]'));
    expect(document.body.textContent).toContain("@agent-3");
    expect(document.body.textContent).not.toContain("@Zara");
  });
});
