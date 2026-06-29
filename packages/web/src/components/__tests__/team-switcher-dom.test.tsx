// @vitest-environment happy-dom

import type { Organization, OrgBrief } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
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
const memberMocks = vi.hoisted(() => ({ leaveMembership: vi.fn() }));
const orgMocks = vi.hoisted(() => ({ updateOrganization: vi.fn() }));

// Mock api so the org list is deterministic, and stub the avatar + the two
// dialogs so assertions key off real text, not identicon SVGs or portal chrome.
vi.mock("../../api/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client.js")>();
  return { ...actual, api: { ...actual.api, get: clientMocks.get } };
});
vi.mock("../../api/members.js", () => memberMocks);
vi.mock("../../api/organizations.js", () => orgMocks);
vi.mock("../avatar.js", () => ({ Avatar: () => <span data-testid="avatar" /> }));
vi.mock("../invite-dialog.js", () => ({ InviteDialog: () => null }));
vi.mock("../team-setup-modal.js", () => ({ TeamSetupModal: () => null }));

function organization(overrides: Partial<Organization> = {}): Organization {
  return {
    id: overrides.id ?? "org-1",
    name: overrides.name ?? "acme",
    displayName: overrides.displayName ?? "Acme Robotics",
    maxAgents: overrides.maxAgents ?? 0,
    maxMessagesPerMinute: overrides.maxMessagesPerMinute ?? 0,
    features: overrides.features ?? {},
    createdAt: overrides.createdAt ?? "2026-05-28T12:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-05-28T12:01:00.000Z",
  };
}

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

function buttonByLabel(scope: ParentNode, label: string): HTMLButtonElement | null {
  return scope.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

function anchorOf(container: ParentNode): HTMLButtonElement {
  const anchor = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
  if (!anchor) throw new Error("anchor missing");
  return anchor;
}

async function setInputValue(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

async function submit(form: HTMLFormElement | null): Promise<void> {
  if (!form) throw new Error("Expected form");
  await act(async () => {
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function waitForText(container: ParentNode, text: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (container.textContent?.includes(text)) return;
    await flush();
  }
  throw new Error(`Expected text "${text}"`);
}

function Harness({
  select,
  role = "admin",
  refreshMe = async () => {},
  redirectHomeOnSwitch = false,
}: {
  select: (id: string) => Promise<void>;
  role?: "admin" | "member";
  refreshMe?: () => Promise<void>;
  redirectHomeOnSwitch?: boolean;
}) {
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
        memberId: organizationId === "org-1" ? "member-1" : organizationId === "org-2" ? "member-2" : "member-3",
        role,
        teamDisplayName: "Acme Robotics",
        memberships: ORGS.map((org) => ({
          id: org.id === "org-1" ? "member-1" : org.id === "org-2" ? "member-2" : "member-3",
          organizationId: org.id,
          organizationName: org.displayName,
          role: org.role,
          agentId: `agent-${org.id}`,
          orgHasOtherMembers: false,
          hasUsableAgent: true,
          onboardingSuppressedAt: null,
          onboardingSuppressedReason: null,
          onboardingCompletedAt: null,
        })),
        currentMembership: {
          id: organizationId === "org-1" ? "member-1" : organizationId === "org-2" ? "member-2" : "member-3",
          organizationId,
          organizationName: organizationId === "org-1" ? "Acme Robotics" : organizationId,
          role,
          agentId: `agent-${organizationId}`,
          orgHasOtherMembers: false,
          hasUsableAgent: true,
          onboardingSuppressedAt: null,
          onboardingSuppressedReason: null,
          onboardingCompletedAt: null,
        },
        user: { id: "u", displayName: "Gandy", username: "gandy", avatarUrl: null },
        switchingOrg,
        setSwitchingOrg,
        selectOrganization: async (id: string) => {
          await select(id);
          setOrganizationId(id);
        },
        refreshMe,
        logout: () => undefined,
      }) as unknown as Parameters<typeof AuthContext.Provider>[0]["value"],
    [organizationId, switchingOrg, select, role, refreshMe],
  );
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/team"]}>
        <AuthContext.Provider value={value}>
          <TeamSwitcher redirectHomeOnSwitch={redirectHomeOnSwitch} />
          <LocationProbe />
        </AuthContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}</span>;
}

async function renderHarness(
  select: (id: string) => Promise<void>,
  options: { role?: "admin" | "member"; refreshMe?: () => Promise<void>; redirectHomeOnSwitch?: boolean } = {},
): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Harness select={select} {...options} />);
  });
  await flush();
  return { container, root };
}

beforeEach(() => {
  document.body.innerHTML = "";
  clientMocks.get.mockResolvedValue(ORGS);
  memberMocks.leaveMembership.mockResolvedValue(undefined);
  orgMocks.updateOrganization.mockImplementation(async (_id: string, patch: Partial<Organization>) =>
    organization({ ...patch }),
  );
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
    expect(buttonByLabel(container, "Edit team name")).not.toBeNull();
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

  it("lets admins rename the current team inline and refreshes auth state", async () => {
    const refreshMe = vi.fn(async () => {});
    const { container, root } = await renderHarness(
      vi.fn(async () => {}),
      { refreshMe },
    );

    await click(anchorOf(container));
    await click(buttonByLabel(container, "Edit team name"));

    const input = container.querySelector<HTMLInputElement>('input[aria-label="Team name"]');
    if (!input) throw new Error("Team name input missing");
    expect(input.value).toBe("Acme Robotics");

    await setInputValue(input, "  Acme Labs  ");
    await submit(container.querySelector("form"));

    expect(orgMocks.updateOrganization).toHaveBeenCalledWith("org-1", { displayName: "Acme Labs" });
    await waitForText(container, "Saved");
    expect(anchorOf(container).textContent).toContain("Acme Labs");
    expect(refreshMe).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
  });

  it("keeps the rename form open and shows the server error when rename fails", async () => {
    orgMocks.updateOrganization.mockRejectedValueOnce(new Error("rename failed"));
    const { container, root } = await renderHarness(vi.fn(async () => {}));

    await click(anchorOf(container));
    await click(buttonByLabel(container, "Edit team name"));
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Team name"]');
    if (!input) throw new Error("Team name input missing");

    await setInputValue(input, "Broken");
    await submit(container.querySelector("form"));

    await waitForText(container, "rename failed");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Team name"]')).not.toBeNull();

    await act(async () => root.unmount());
  });

  it("does not expose the team rename affordance to non-admin members", async () => {
    const { container, root } = await renderHarness(
      vi.fn(async () => {}),
      { role: "member" },
    );

    await click(anchorOf(container));

    expect(buttonByLabel(container, "Edit team name")).toBeNull();
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Team name"]')).toBeNull();

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

  it("lets a user leave the current team, refreshes auth state, and switches to the next team", async () => {
    const refreshMe = vi.fn(async () => {});
    const select = vi.fn(async () => {});
    const { container, root } = await renderHarness(select, { refreshMe });

    await click(anchorOf(container));
    await click(buttonByText(container, "Leave this team"));

    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain("Leave Acme Robotics?");
    expect(document.body.textContent).toContain("This removes only your membership");

    await click(buttonByText(document.body, "Leave team"));

    expect(memberMocks.leaveMembership).toHaveBeenCalledWith("member-1");
    expect(refreshMe).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith("org-2");

    await act(async () => root.unmount());
  });

  it("routes to onboarding recovery when a user leaves their last team", async () => {
    clientMocks.get.mockResolvedValue([ORGS[0]]);
    const refreshMe = vi.fn(async () => {});
    const select = vi.fn(async () => {});
    const { container, root } = await renderHarness(select, { refreshMe, redirectHomeOnSwitch: true });

    await click(anchorOf(container));
    await click(buttonByText(container, "Leave this team"));
    await click(buttonByText(document.body, "Leave team"));

    expect(memberMocks.leaveMembership).toHaveBeenCalledWith("member-1");
    expect(refreshMe).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe("/onboarding");

    await act(async () => root.unmount());
  });
});
