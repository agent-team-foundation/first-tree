import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "../login.js";

const authState = {
  value: {
    isAuthenticated: false,
  },
};

vi.mock("../../auth/auth-context.js", () => ({
  useAuth: () => authState.value,
}));

function renderLogin(hostname: string, state?: unknown): string {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { hostname } },
  });
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[{ pathname: "/login", state }]}>
      <LoginPage />
    </MemoryRouter>,
  );
}

describe("LoginPage", () => {
  beforeEach(() => {
    authState.value = { isAuthenticated: false };
  });

  it("renders GitHub sign-in with a safe deep-link target", () => {
    const html = renderLogin("app.example.test", {
      from: { pathname: "/context", search: "?node=root", hash: "#details" },
    });

    expect(html).toContain("Sign in with GitHub");
    expect(html).toContain("/api/v1/auth/github/start?next=%2Fcontext%3Fnode%3Droot%23details");
    expect(html).not.toContain("Dev: skip GitHub");
  });

  it("shows localhost-only dev auth and redirects authenticated users", () => {
    expect(renderLogin("127.0.0.1")).toContain("Dev: skip GitHub");

    authState.value = { isAuthenticated: true };
    expect(renderLogin("localhost")).toBe("");
  });
});
