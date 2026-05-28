import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedbackRouteConfig } from "../api/feedback.js";

const hearbackMock = vi.hoisted(() => ({
  handle: vi.fn(),
}));

type FeedbackRoute = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

vi.mock("hearback-server", () => ({
  createFeedbackHandler: () => ({ handle: hearbackMock.handle }),
}));

function createReply(): FastifyReply {
  const reply = {
    headers: vi.fn(() => reply),
    raw: {
      end: vi.fn(),
      write: vi.fn(),
    },
    send: vi.fn(() => reply),
    status: vi.fn(() => reply),
  };
  // Minimal FastifyReply double for the feedback adapter.
  return reply as unknown as FastifyReply;
}

async function* chunks(): AsyncGenerator<Uint8Array> {
  yield new Uint8Array([1, 2, 3]);
  yield new Uint8Array([4]);
}

describe("feedbackRoutes", () => {
  beforeEach(() => {
    vi.resetModules();
    hearbackMock.handle.mockReset();
  });

  it("mounts the hearback handler with trusted proxy IP and buffered uploads", async () => {
    const { feedbackRoutes } = await import("../api/feedback.js");
    let route: FeedbackRoute = async () => {
      throw new Error("feedback route was not registered");
    };
    let routeRegistered = false;
    const app = {
      addContentTypeParser: vi.fn(),
      all: vi.fn((_path: string, handler: FeedbackRoute) => {
        route = handler;
        routeRegistered = true;
      }),
    };

    await feedbackRoutes(app as unknown as FastifyInstance, { trustProxyHeaders: true } as FeedbackRouteConfig);

    expect(app.addContentTypeParser).toHaveBeenCalledWith(/^image\//, { parseAs: "buffer" }, expect.any(Function));
    expect(app.all).toHaveBeenCalledWith("/*", expect.any(Function));
    expect(routeRegistered).toBe(true);

    hearbackMock.handle.mockResolvedValueOnce({
      body: { ok: true },
      headers: { "x-feedback": "ok" },
      status: 201,
    });
    const reply = createReply();
    await route(
      {
        body: Buffer.from("image"),
        headers: { "x-forwarded-for": " 203.0.113.10, 10.0.0.1 ", "x-test": ["a", "b"] },
        ip: "127.0.0.1",
        method: "POST",
        url: "/feedback/upload?x=1",
      } as unknown as FastifyRequest,
      reply,
    );

    expect(hearbackMock.handle).toHaveBeenCalledWith({
      body: {},
      headers: { "x-forwarded-for": " 203.0.113.10, 10.0.0.1 ", "x-test": "a" },
      ip: "203.0.113.10",
      method: "POST",
      path: "/upload",
      rawBody: Buffer.from("image"),
    });
    expect(reply.status).toHaveBeenCalledWith(201);
    expect(reply.headers).toHaveBeenCalledWith({ "x-feedback": "ok" });
    expect(reply.send).toHaveBeenCalledWith({ ok: true });
  });

  it("falls back to socket IP and streams async iterable bodies", async () => {
    const { feedbackRoutes } = await import("../api/feedback.js");
    let route: FeedbackRoute = async () => {
      throw new Error("feedback route was not registered");
    };
    let routeRegistered = false;
    const app = {
      addContentTypeParser: vi.fn(),
      all: vi.fn((_path: string, handler: FeedbackRoute) => {
        route = handler;
        routeRegistered = true;
      }),
    };

    await feedbackRoutes(app as unknown as FastifyInstance, { trustProxyHeaders: false } as FeedbackRouteConfig);
    expect(routeRegistered).toBe(true);

    hearbackMock.handle.mockResolvedValueOnce({ body: chunks(), headers: {}, status: 200 });
    const streamReply = createReply();
    await route(
      {
        body: { message: "hello" },
        headers: { "x-forwarded-for": "203.0.113.10" },
        ip: "127.0.0.1",
        method: "GET",
        url: "/prefix/feedback/chat",
      } as unknown as FastifyRequest,
      streamReply,
    );
    expect(hearbackMock.handle).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: { message: "hello" }, ip: "127.0.0.1", path: "/chat", rawBody: undefined }),
    );
    expect(streamReply.raw.write).toHaveBeenCalledTimes(2);
    expect(streamReply.raw.end).toHaveBeenCalledTimes(1);
    expect(streamReply.send).not.toHaveBeenCalled();

    hearbackMock.handle.mockResolvedValueOnce({ body: null, headers: {}, status: 204 });
    const emptyReply = createReply();
    await route(
      {
        body: undefined,
        headers: {},
        ip: undefined,
        method: "DELETE",
        url: "/feedback",
      } as unknown as FastifyRequest,
      emptyReply,
    );
    expect(emptyReply.send).toHaveBeenCalledWith();
  });
});
