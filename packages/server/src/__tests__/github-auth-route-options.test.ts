import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { githubOauthRoutes } from "../api/auth/github.js";
import { orgGithubAppRoutes } from "../api/orgs/github-app.js";

type RegisteredRoute = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  options: unknown;
};

function routeCollector(): { app: FastifyInstance; routes: RegisteredRoute[] } {
  const routes: RegisteredRoute[] = [];
  const register =
    (method: RegisteredRoute["method"]) =>
    (...args: unknown[]) => {
      const [path, maybeOptions] = args;
      routes.push({
        method,
        path: String(path),
        options: args.length === 3 ? maybeOptions : undefined,
      });
    };
  return {
    app: {
      get: register("GET"),
      post: register("POST"),
      delete: register("DELETE"),
    } as unknown as FastifyInstance,
    routes,
  };
}

describe("GitHub authorization route protection", () => {
  it("rate-limits install URL authorization before OAuth state is minted", async () => {
    const collector = routeCollector();
    await orgGithubAppRoutes(collector.app);
    const route = collector.routes.find((candidate) => candidate.method === "GET" && candidate.path === "/install-url");
    const config =
      route?.options && typeof route.options === "object" ? Reflect.get(route.options, "config") : undefined;

    expect(route).toBeDefined();
    expect(config).toEqual({ rateLimit: { max: 60, timeWindow: "1 minute" } });
  });

  it.each(["/start", "/callback"])("rate-limits the GitHub OAuth %s route", async (path) => {
    const collector = routeCollector();
    Reflect.set(collector.app, "config", { oauth: { githubApp: {} } });
    await githubOauthRoutes(collector.app);
    const route = collector.routes.find((candidate) => candidate.method === "GET" && candidate.path === path);
    const config =
      route?.options && typeof route.options === "object" ? Reflect.get(route.options, "config") : undefined;

    expect(route).toBeDefined();
    expect(config).toEqual({ rateLimit: { max: 60, timeWindow: "1 minute" } });
  });
});
