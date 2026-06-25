// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRepoWorkIntent } from "../intent.js";
import { RepoWorkLandingPage } from "../repo-work-landing.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const authMock = vi.hoisted(() => ({
  value: {
    isAuthenticated: false,
  },
}));

const eventMocks = vi.hoisted(() => ({
  reportOnboardingEvent: vi.fn(async () => undefined),
}));

vi.mock("../../../auth/auth-context.js", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => authMock.value,
}));

vi.mock("../../../api/onboarding-events.js", () => eventMocks);

function createStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

let root: Root | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  Object.defineProperty(window, "sessionStorage", { configurable: true, value: createStorage() });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: window.sessionStorage });
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { assign: vi.fn(), hostname: "localhost" },
  });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

async function renderPage(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <MemoryRouter>
        <RepoWorkLandingPage />
      </MemoryRouter>,
    );
  });
  return container;
}

describe("RepoWorkLandingPage", () => {
  it("stores repo intent in sessionStorage and starts GitHub identity login", async () => {
    const container = await renderPage();
    const input = container.querySelector("input[name='repoUrl']");
    if (!(input instanceof HTMLInputElement)) throw new Error("repo input not found");

    await act(async () => {
      input.value = "https://github.com/acme/backend";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const form = container.querySelector("form");
    if (!(form instanceof HTMLFormElement)) throw new Error("form not found");
    await act(async () => {
      form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    });

    expect(readRepoWorkIntent()).toEqual({
      owner: "acme",
      repo: "backend",
      repoSlug: "acme/backend",
      url: "https://github.com/acme/backend",
    });
    expect(eventMocks.reportOnboardingEvent).toHaveBeenCalledWith("repo_work_landing_submitted", {
      repoHost: "github.com",
    });
    expect(window.location.assign).toHaveBeenCalledWith("/api/v1/auth/github/start?next=%2Frepo-work%2Fstart");
  });

  it("does not store invalid repo URLs", async () => {
    const container = await renderPage();
    const input = container.querySelector("input[name='repoUrl']");
    if (!(input instanceof HTMLInputElement)) throw new Error("repo input not found");
    await act(async () => {
      input.value = "https://gitlab.com/acme/backend";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const form = container.querySelector("form");
    if (!(form instanceof HTMLFormElement)) throw new Error("form not found");
    await act(async () => {
      form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    });

    expect(readRepoWorkIntent()).toBeNull();
    expect(container.textContent).toContain("Enter a GitHub repository URL");
    expect(window.location.assign).not.toHaveBeenCalled();
  });
});
