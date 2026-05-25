import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it } from "vitest";
import { createCommandVersionPoller } from "../services/command-version-poller.js";

/**
 * Stub logger that swallows everything. Keeps test output clean — the
 * poller intentionally logs at `warn` on every failed fetch and at `info`
 * on every version change, neither of which we want in the test runner.
 */
const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => silentLogger,
  level: "info",
  silent: () => {},
} as unknown as FastifyBaseLogger;

/** Build a `fetch`-shaped stub that responds with the given packument body. */
function stubFetchWithBody(body: unknown, status = 200) {
  const impl: typeof fetch = async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  return impl;
}

describe("createCommandVersionPoller", () => {
  it("starts with the supplied bootstrap version", () => {
    const poller = createCommandVersionPoller({
      logger: silentLogger,
      registryUrl: "https://example.test",
      packageName: "@scope/pkg",
      intervalMs: 60_000,
      initialVersion: "0.14.6",
      fetchImpl: stubFetchWithBody({ "dist-tags": {} }),
    });

    expect(poller.get()).toBe("0.14.6");
  });

  it("updates the cached version when refresh finds a different latest", async () => {
    const poller = createCommandVersionPoller({
      logger: silentLogger,
      registryUrl: "https://example.test",
      packageName: "@scope/pkg",
      intervalMs: 60_000,
      initialVersion: "0.14.6",
      fetchImpl: stubFetchWithBody({ "dist-tags": { latest: "0.14.8" } }),
    });

    await poller.refresh();
    expect(poller.get()).toBe("0.14.8");
  });

  it("keeps the previous version when the registry returns a non-OK response", async () => {
    const failingFetch: typeof fetch = async () => new Response("server error", { status: 500 });
    const poller = createCommandVersionPoller({
      logger: silentLogger,
      registryUrl: "https://example.test",
      packageName: "@scope/pkg",
      intervalMs: 60_000,
      initialVersion: "0.14.6",
      fetchImpl: failingFetch,
    });

    await poller.refresh();
    expect(poller.get()).toBe("0.14.6");
  });

  it("keeps the previous version when the 'latest' dist-tag is missing", async () => {
    const poller = createCommandVersionPoller({
      logger: silentLogger,
      registryUrl: "https://example.test",
      packageName: "@scope/pkg",
      intervalMs: 60_000,
      initialVersion: "0.14.7",
      fetchImpl: stubFetchWithBody({ "dist-tags": { beta: "0.15.0-beta.1" } }),
    });

    await poller.refresh();
    expect(poller.get()).toBe("0.14.7");
  });

  it("keeps the previous version when fetch throws", async () => {
    const throwingFetch: typeof fetch = async () => {
      throw new Error("ENETUNREACH");
    };
    const poller = createCommandVersionPoller({
      logger: silentLogger,
      registryUrl: "https://example.test",
      packageName: "@scope/pkg",
      intervalMs: 60_000,
      initialVersion: "0.14.6",
      fetchImpl: throwingFetch,
    });

    await poller.refresh();
    expect(poller.get()).toBe("0.14.6");
  });

  it("builds the registry URL with the package name appended unencoded", async () => {
    const calls: string[] = [];
    const recordingFetch: typeof fetch = async (input) => {
      calls.push(typeof input === "string" ? input : (input as URL).toString());
      return new Response(JSON.stringify({ "dist-tags": { latest: "1.0.0" } }), { status: 200 });
    };
    const poller = createCommandVersionPoller({
      logger: silentLogger,
      registryUrl: "https://example.test/",
      packageName: "first-tree-staging",
      intervalMs: 60_000,
      initialVersion: "0.0.0",
      fetchImpl: recordingFetch,
    });

    await poller.refresh();
    expect(calls).toHaveLength(1);
    // Trailing slash on registryUrl must be stripped; `@scope/name` must
    // survive encoding so npm registry can resolve the packument.
    expect(calls[0]).toBe("https://example.test/first-tree-staging");
  });

  it("stop() prevents further refreshes from mutating state", async () => {
    let body = { "dist-tags": { latest: "0.14.6" } };
    const dynamicFetch: typeof fetch = async () => new Response(JSON.stringify(body), { status: 200 });
    const poller = createCommandVersionPoller({
      logger: silentLogger,
      registryUrl: "https://example.test",
      packageName: "@scope/pkg",
      intervalMs: 60_000,
      initialVersion: "0.14.5",
      fetchImpl: dynamicFetch,
    });

    await poller.refresh();
    expect(poller.get()).toBe("0.14.6");

    poller.stop();
    body = { "dist-tags": { latest: "9.9.9" } };
    await poller.refresh();
    expect(poller.get()).toBe("0.14.6");
  });

  it("packageName=null returns a no-op poller that never fetches", async () => {
    let fetched = false;
    const dummyFetch: typeof fetch = async () => {
      fetched = true;
      return new Response("{}", { status: 200 });
    };
    const poller = createCommandVersionPoller({
      logger: silentLogger,
      registryUrl: "https://example.test",
      packageName: null,
      intervalMs: 60_000,
      initialVersion: "0.0.0-dev",
      fetchImpl: dummyFetch,
    });

    expect(poller.get()).toBe("0.0.0-dev");
    poller.start();
    await poller.refresh();
    expect(fetched).toBe(false);
    expect(poller.get()).toBe("0.0.0-dev");
    poller.stop();
  });
});
