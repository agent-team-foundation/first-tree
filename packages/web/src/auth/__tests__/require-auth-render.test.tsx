import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequireAuth } from "../require-auth.js";

const authState = {
  value: {
    isAuthenticated: false,
    meLoaded: false,
  },
};

vi.mock("../auth-context.js", () => ({
  useAuth: () => authState.value,
}));

function renderAt(path: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<RequireAuth />}>
          <Route path="/" element={<div>workspace outlet</div>} />
          <Route path="/context" element={<div>context outlet</div>} />
        </Route>
        <Route path="/login" element={<div>login page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("RequireAuth", () => {
  beforeEach(() => {
    authState.value = { isAuthenticated: false, meLoaded: false };
  });

  it("renders the public landing fallback on / for unauthenticated visitors", () => {
    expect(RequireAuth).toBeDefined();
    expect(renderAt("/")).toContain("landing-marketing");
  });

  it("redirects unauthenticated deep links to login", () => {
    expect(renderAt("/context?tab=tree#node")).toBe("");
  });

  it("holds authenticated users on the neutral fallback until /me loads, then renders the child route", () => {
    authState.value = { isAuthenticated: true, meLoaded: false };
    expect(renderAt("/")).toContain("landing-marketing");

    authState.value = { isAuthenticated: true, meLoaded: true };
    expect(renderAt("/context")).toContain("context outlet");
  });
});
