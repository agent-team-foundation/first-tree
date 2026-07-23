import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { gitlabConnectionRoutes } from "../api/gitlab-connections.js";
import { orgContextTreeRoutes } from "../api/orgs/context-tree.js";
import { orgGitlabConnectionRoutes } from "../api/orgs/gitlab-connections.js";

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

describe("GitLab connection mutation route protection", () => {
  it.each([
    {
      register: gitlabConnectionRoutes,
      path: "/:connectionId/replace",
    },
    {
      register: orgGitlabConnectionRoutes,
      path: "/",
    },
  ])("keeps the global rate limiter on POST $path", async ({ register, path }) => {
    const collector = routeCollector();
    await register(collector.app);
    const route = collector.routes.find((candidate) => candidate.method === "POST" && candidate.path === path);
    const config =
      route?.options && typeof route.options === "object" ? Reflect.get(route.options, "config") : undefined;

    expect(route).toBeDefined();
    expect(config).toBeDefined();
    expect(Reflect.has(config, "rateLimit")).toBe(true);
    expect(Reflect.get(config, "rateLimit")).toBeUndefined();
  });

  it("keeps the global rate limiter on Seed preflight", async () => {
    const collector = routeCollector();
    await orgContextTreeRoutes(collector.app);
    const route = collector.routes.find(
      (candidate) => candidate.method === "POST" && candidate.path === "/seed-preflight",
    );
    const config =
      route?.options && typeof route.options === "object" ? Reflect.get(route.options, "config") : undefined;

    expect(route).toBeDefined();
    expect(config).toBeDefined();
    expect(Reflect.has(config, "rateLimit")).toBe(true);
    expect(Reflect.get(config, "rateLimit")).toBeUndefined();
  });
});
