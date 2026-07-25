// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const authMock = vi.hoisted(() => ({
  value: {
    user: { id: "user-1", username: "gandy", displayName: "Gandy", avatarUrl: null },
    logout: vi.fn(),
  },
}));

vi.mock("../../auth/auth-context.js", () => ({
  useAuth: () => authMock.value,
}));

let root: Root | null = null;
let container: HTMLElement | null = null;
const originalLocation = window.location;

async function renderUserMenu(): Promise<void> {
  const { UserMenu } = await import("../user-menu.js");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <MemoryRouter>
        <UserMenu />
      </MemoryRouter>,
    );
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
  authMock.value.logout = vi.fn();
  // Swap window.location for a plain writable object so the full-page
  // sign-out navigation is observable without happy-dom actually navigating.
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { href: "http://localhost/workspace" },
  });
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  root = null;
  container = null;
  document.body.innerHTML = "";
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
});

describe("UserMenu sign out", () => {
  it("navigates to the marketing site only after the async logout (purge included) resolves", async () => {
    let resolveLogout: (() => void) | null = null;
    authMock.value.logout.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveLogout = resolve;
        }),
    );
    await renderUserMenu();

    await act(async () => {
      container?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')?.click();
    });
    const signOut =
      [...(container?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.includes("Sign out")) ??
      null;
    expect(signOut).not.toBeNull();

    await act(async () => {
      signOut?.click();
      await Promise.resolve();
    });

    // Ordering contract (SEC-042): while logout — and the local-data purge it
    // awaits — is still in flight, the full-page navigation that would cut
    // the purge short must NOT have happened yet.
    expect(authMock.value.logout).toHaveBeenCalledTimes(1);
    expect(window.location.href).toBe("http://localhost/workspace");

    await act(async () => {
      resolveLogout?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(window.location.href).toBe("https://first-tree.ai");
  });
});
