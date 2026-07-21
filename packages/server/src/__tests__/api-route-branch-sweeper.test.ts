import { afterEach, describe, expect, it, vi } from "vitest";
import { agentConfigRoutes } from "../api/agent/config.js";
import { healthRoutes } from "../api/health.js";
import { healthzRoutes } from "../api/healthz.js";
import { publicInvitationRoutes } from "../api/invitations.js";
import { readyzRoutes } from "../api/readyz.js";
import { bootstrapState } from "../bootstrap-state.js";
import { UnauthorizedError } from "../errors.js";
import { previewInvitation } from "../services/invitation.js";

vi.mock("../services/invitation.js", () => ({
  previewInvitation: vi.fn(),
}));

type UnknownFn = (...args: unknown[]) => unknown;
type CapturedRoute = {
  method: string;
  path: string;
  options: unknown;
  handler: UnknownFn;
};

function createApp(overrides: Record<string, unknown> = {}): { app: Record<string, unknown>; routes: CapturedRoute[] } {
  const routes: CapturedRoute[] = [];
  const registerRoute = (method: string) => (path: string, optionsOrHandler?: unknown, maybeHandler?: unknown) => {
    const handler = typeof optionsOrHandler === "function" ? optionsOrHandler : maybeHandler;
    const options = typeof optionsOrHandler === "function" ? undefined : optionsOrHandler;
    if (typeof handler !== "function") throw new Error(`Missing handler for ${method} ${path}`);
    routes.push({ method, path, options, handler: handler as UnknownFn });
    return app;
  };
  const app = {
    databaseReadinessProbe: { check: vi.fn(async () => "connected" as const) },
    db: { execute: vi.fn(async () => [{ one: 1 }]) },
    get: registerRoute("GET"),
    ...overrides,
  };
  return { app, routes };
}

function replyDouble(): { status: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> } {
  const reply = {
    status: vi.fn(() => reply),
    send: vi.fn((body: unknown) => body),
  };
  return reply;
}

async function registerSingleRoute(
  register: (app: never) => Promise<void>,
  overrides: Record<string, unknown> = {},
): Promise<{ app: Record<string, unknown>; route: CapturedRoute }> {
  const { app, routes } = createApp(overrides);
  await register(app as never);
  expect(routes).toHaveLength(1);
  const route = routes[0];
  if (!route) throw new Error("Route was not captured");
  return { app, route };
}

const originalBootstrapState = {
  startedAt: bootstrapState.startedAt,
  readyAt: bootstrapState.readyAt,
  stages: { ...bootstrapState.stages },
};

describe("API route branch contracts", () => {
  afterEach(() => {
    vi.clearAllMocks();
    bootstrapState.startedAt = originalBootstrapState.startedAt;
    bootstrapState.readyAt = originalBootstrapState.readyAt;
    bootstrapState.stages = { ...originalBootstrapState.stages };
  });

  it("reports degraded /health when the database probe fails", async () => {
    const healthy = await registerSingleRoute(healthRoutes);
    await expect(healthy.route.handler({}, replyDouble())).resolves.toEqual({ status: "ok", db: "connected" });
    expect((healthy.app.databaseReadinessProbe as { check: ReturnType<typeof vi.fn> }).check).toHaveBeenCalledTimes(1);

    const check = vi.fn(async () => "disconnected" as const);
    const degraded = await registerSingleRoute(healthRoutes, { databaseReadinessProbe: { check } });

    await expect(degraded.route.handler({}, replyDouble())).resolves.toEqual({
      status: "degraded",
      db: "disconnected",
    });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("keeps /healthz as a database-free liveness check", async () => {
    const execute = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const check = vi.fn(async () => "disconnected" as const);
    const live = await registerSingleRoute(healthzRoutes, {
      databaseReadinessProbe: { check },
      db: { execute },
    });
    const reply = replyDouble();
    await live.route.handler({}, reply);

    expect(live.route.options).toEqual({ config: { rateLimit: false } });
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({ status: "ok" });
    expect(execute).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it("keeps /readyz unavailable until every bootstrap stage is done", async () => {
    bootstrapState.startedAt = new Date("2026-01-01T00:00:00.000Z");
    bootstrapState.readyAt = null;
    bootstrapState.stages = {
      initTelemetry: { status: "done" },
      runMigrations: { status: "failed", error: "migration lock contention" },
      buildApp: { status: "pending" },
      appListen: { status: "pending" },
    };
    const { app, route } = await registerSingleRoute(readyzRoutes);
    const reply = replyDouble();

    await route.handler({}, reply);

    expect(route.options).toEqual({ config: { rateLimit: false } });
    expect(reply.status).toHaveBeenCalledWith(503);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        db: "unchecked",
        ready: false,
        startedAt: "2026-01-01T00:00:00.000Z",
        readyAt: null,
        stages: expect.objectContaining({
          runMigrations: { status: "failed", error: "migration lock contention" },
        }),
      }),
    );
    expect((app.databaseReadinessProbe as { check: ReturnType<typeof vi.fn> }).check).not.toHaveBeenCalled();
  });

  it("previews public invitations without exposing tokenless requests", async () => {
    const { route } = await registerSingleRoute(publicInvitationRoutes);

    await expect(route.handler({ params: { token: "" } }, replyDouble())).rejects.toBeInstanceOf(UnauthorizedError);
    expect(previewInvitation).not.toHaveBeenCalled();

    const preview = {
      organizationId: "org_1",
      organizationName: "acme",
      organizationDisplayName: "Acme",
      role: "member",
      expiresAt: "2026-01-08T00:00:00.000Z",
    };
    vi.mocked(previewInvitation).mockResolvedValueOnce(preview);
    const reply = replyDouble();

    await route.handler({ params: { token: "invite_token" } }, reply);

    expect(previewInvitation).toHaveBeenCalledWith(expect.anything(), "invite_token");
    expect(reply.send).toHaveBeenCalledWith(preview);
  });

  it("resolves agent runtime config for the authenticated agent identity", async () => {
    const getDecrypted = vi.fn(async () => ({ env: { TOKEN: "plain" }, command: "run" }));
    const resolveRuntimeConfig = vi.fn((config: unknown) => ({ resolved: true, config }));
    const { route } = await registerSingleRoute(agentConfigRoutes, {
      configService: { getDecrypted },
      resourcesService: { resolveRuntimeConfig },
    });

    await expect(route.handler({ agent: { uuid: "agent_1" } }, replyDouble())).resolves.toEqual({
      resolved: true,
      config: { env: { TOKEN: "plain" }, command: "run" },
    });
    expect(getDecrypted).toHaveBeenCalledWith("agent_1");
    expect(resolveRuntimeConfig).toHaveBeenCalledWith({ env: { TOKEN: "plain" }, command: "run" });

    await expect(route.handler({}, replyDouble())).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
