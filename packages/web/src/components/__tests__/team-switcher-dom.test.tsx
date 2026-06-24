// @vitest-environment happy-dom

import type { OrgBrief } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext } from "../../auth/auth-context.js";
import { TeamSwitcher } from "../team-switcher.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ORGS: OrgBrief[] = [
  { id: "org-1", name: "acme", displayName: "Acme Robotics", role: "admin" },
  { id: "org-2", name: "globex", displayName: "Globex", role: "member" },
  { id: "org-3", name: "initech", displayName: "Initech", role: "member" },
];

const clientMocks = vi.hoisted(() => ({ get: vi.fn() }));

// Mock api so the org list is deterministic, and stub the avatar + the two
// dialogs so assertions key off real text, not identicon SVGs or portal chrome.
vi.mock("../../api/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client.js")>();
  return { ...actual, api: { ...actual.api, get: clientMocks.get } };
});
vi.mock("../avatar.js", () => ({ Avatar: () => <span data-testid="avatar" /> }));
vi.mock("../invite-dialog.js", () => ({ InviteDialog: () => null }));
vi.mock("../team-setup-modal.js", () => ({ TeamSetupModal: () => null }));

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

function buttonByText(scope: ParentNode, text: string): HTMLButtonElement | null {
  return [...scope.querySelectorAll("button")].find((b) => b.textContent?.includes(text)) ?? null;
}

function anchorOf(container: ParentNode): HTMLButtonElement {
  const anchor = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
  if (!anchor) throw new Error("anchor missing");
  return anchor;
}

function Harness({ select }: { select: (id: string) => Promise<void> }) {
  // Fresh client per mount so the ['me-organizations'] cache never leaks across
  // tests (the single-team case swaps the mock and must not read a stale list).
  const queryClient = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }), []);
  const [organizationId, setOrganizationId] = useState("org-1");
  const [switchingOrg, setSwitchingOrg] = useState<OrgBrief | null>(null);
  const value = useMemo(
    () =>
      ({
        isAuthenticated: true,
        meLoaded: true,
        organizationId,
        role: "admin",
        teamDisplayName: "Acme Robotics",
        user: { id: "u", displayName: "Gandy", username: "gandy", avatarUrl: null },
        switchingOrg,
        setSwitchingOrg,
        selectOrganization: async (id: string) => {
          await select(id);
          setOrganizationId(id);
        },
        logout: () => undefined,
      }) as unknown as Parameters<typeof AuthContext.Provider>[0]["value"],
    [organizationId, switchingOrg, select],
  );
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AuthContext.Provider value={value}>
          <TeamSwitcher redirectHomeOnSwitch={false} />
        </AuthContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function renderHarness(select: (id: string) => Promise<void>): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Harness select={select} />);
  });
  await flush();
  return { container, root };
}

beforeEach(() => {
  document.body.innerHTML = "";
  clientMocks.get.mockResolvedValue(ORGS);
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("TeamSwitcher", () => {
  it("shows the current team on the anchor and opens a menu with the other teams + management actions", async () => {
    const { container, root } = await renderHarness(vi.fn(async () => {}));

    expect(anchorOf(container).textContent).toContain("Acme Robotics");

    await click(anchorOf(container));
    expect(container.textContent).toContain("current team");
    expect(container.textContent).toContain("Switch team");
    expect(buttonByText(container, "Globex")).not.toBeNull();
    expect(buttonByText(container, "Initech")).not.toBeNull();
    // The current team is in the header, not the switch list.
    expect(buttonByText(container, "Globex")?.getAttribute("role")).toBe("menuitem");
    expect(buttonByText(container, "Create new team")).not.toBeNull();
    expect(buttonByText(container, "Join with invite link")).not.toBeNull();
    expect(buttonByText(container, "Invite teammates")).not.toBeNull();

    await act(async () => root.unmount());
  });

  it("drives the in-flight switch from one signal: optimistic anchor, row spinner, disabled list, no double-click", async () => {
    const gate = deferred();
    const select = vi.fn(() => gate.promise);
    const { container, root } = await renderHarness(select);

    await click(anchorOf(container));
    await click(buttonByText(container, "Globex"));

    // Optimistic anchor flips to the target while the switch is in flight.
    expect(anchorOf(container).textContent).toContain("Globex");
    // The picked row spins…
    expect(container.querySelector(".animate-spin")).not.toBeNull();
    // …and the rest of the list is disabled.
    expect(buttonByText(container, "Initech")?.disabled).toBe(true);

    // A second click while switching is ignored (hard guard).
    await click(buttonByText(container, "Initech"));
    expect(select).toHaveBeenCalledTimes(1);

    // Settle: the promise resolves, the veil floor elapses, the anchor lands.
    gate.resolve();
    await flush();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    await flush();
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(anchorOf(container).textContent).toContain("Globex");

    await act(async () => root.unmount());
  });

  it("rolls back and shows an inline retry hint when the switch fails, keeping the menu open", async () => {
    const gate = deferred();
    const select = vi.fn(() => gate.promise);
    const { container, root } = await renderHarness(select);

    await click(anchorOf(container));
    await click(buttonByText(container, "Globex"));
    expect(anchorOf(container).textContent).toContain("Globex");

    gate.reject(new Error("switch failed"));
    await flush();

    // Anchor reverts to the current team; an inline hint appears; menu stays open.
    expect(anchorOf(container).textContent).toContain("Acme Robotics");
    expect(container.textContent).toContain("Couldn't switch — try again");
    expect(buttonByText(container, "Globex")).not.toBeNull();
    expect(container.querySelector(".animate-spin")).toBeNull();

    await act(async () => root.unmount());
  });

  it("keeps the anchor but hides the switch list for a single-team user", async () => {
    clientMocks.get.mockResolvedValue([ORGS[0]]);
    const { container, root } = await renderHarness(vi.fn(async () => {}));

    expect(anchorOf(container).textContent).toContain("Acme Robotics");
    await click(anchorOf(container));

    expect(container.textContent).not.toContain("Switch team");
    expect(buttonByText(container, "Globex")).toBeNull();
    // Management actions are still present for single-team users.
    expect(buttonByText(container, "Create new team")).not.toBeNull();

    await act(async () => root.unmount());
  });
});
