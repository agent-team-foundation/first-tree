// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequireAuth, scanCampaignOAuthNext } from "../require-auth.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const authMock = vi.hoisted(() => ({
  value: { isAuthenticated: false as boolean, meLoaded: false as boolean },
}));
vi.mock("../auth-context.js", () => ({ useAuth: () => authMock.value }));
vi.mock("../../pages/landing/index.js", () => ({ LandingPage: () => <div>Landing content</div> }));

const SCAN_ATTEMPT_ID = "123e4567-e89b-42d3-a456-426614174000";
const SCAN_URL =
  "/quickstart?campaign=production-scan&repo=https%3A%2F%2Fgithub.com%2Facme%2Fbackend" +
  `&attempt=${SCAN_ATTEMPT_ID}&variant=control`;
const VITE_GENERATION = "0123456789abcdef0123456789abcdef";

describe("scanCampaignOAuthNext", () => {
  it("returns the quickstart URL for a known campaign handoff", () => {
    expect(
      scanCampaignOAuthNext({
        pathname: "/quickstart",
        search:
          "?campaign=production-scan&repo=https%3A%2F%2Fgithub.com%2Facme%2Fbackend" +
          `&attempt=${SCAN_ATTEMPT_ID}&variant=control`,
      }),
    ).toBe(SCAN_URL);
  });

  it("returns null for an unknown campaign", () => {
    expect(scanCampaignOAuthNext({ pathname: "/quickstart", search: "?campaign=bogus" })).toBeNull();
  });

  it("returns null when there is no campaign param", () => {
    expect(scanCampaignOAuthNext({ pathname: "/quickstart", search: "" })).toBeNull();
  });

  it("returns null off the quickstart path", () => {
    expect(scanCampaignOAuthNext({ pathname: "/settings", search: "?campaign=production-scan" })).toBeNull();
  });
});

describe("RequireAuth — scan funnel login handoff", () => {
  let root: Root | null = null;
  let replaceSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    authMock.value = { isAuthenticated: false, meLoaded: false };
    window.sessionStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            v: 1,
            authority: "https://s1.example/api/v1",
            viteGeneration: VITE_GENERATION,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    replaceSpy = vi.spyOn(window.location, "replace").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    replaceSpy.mockRestore();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  async function renderRoute(path: string): Promise<HTMLElement> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const queryClient = new QueryClient();
    await act(async () => {
      root?.render(
        <MemoryRouter initialEntries={[path]}>
          <QueryClientProvider client={queryClient}>
            <Routes>
              <Route element={<RequireAuth />}>
                <Route path="/quickstart" element={<div>Quickstart</div>} />
                <Route path="/settings" element={<div>Settings</div>} />
              </Route>
              <Route path="/login" element={<div>Login page</div>} />
            </Routes>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    return container;
  }

  it("sends an unauthenticated scan visitor straight to GitHub OAuth, skipping /login", async () => {
    const container = await renderRoute(SCAN_URL);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const target = replaceSpy.mock.calls[0]?.[0];
    expect(target).toMatch(
      new RegExp(
        `^/api/v1/auth/github/start\\?next=${encodeURIComponent(SCAN_URL)}&ft_vite_nav=v1\\.${VITE_GENERATION}\\.`,
      ),
    );
    expect(container.textContent).not.toContain("Login page");
    const stored = window.sessionStorage.getItem("first-tree:auth-attempt") ?? "";
    expect(JSON.parse(stored)).toMatchObject({
      provider: "github",
      entryPoint: "campaign",
      scanAttemptId: SCAN_ATTEMPT_ID,
      variant: "control",
    });
    expect(stored).not.toContain("repo");
  });

  it("keeps a normal unauthenticated deep link on the /login interstitial", async () => {
    const container = await renderRoute("/settings");
    expect(replaceSpy).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Login page");
  });

  it("does not record or navigate an acquisition attempt when navigation proof construction fails", async () => {
    vi.stubGlobal(
      "btoa",
      vi.fn(() => {
        throw new Error("proof encoder unavailable");
      }),
    );
    const container = await renderRoute(SCAN_URL);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(replaceSpy).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("first-tree:auth-attempt")).toBeNull();
    expect(container.textContent).not.toContain("Login page");
  });
});
