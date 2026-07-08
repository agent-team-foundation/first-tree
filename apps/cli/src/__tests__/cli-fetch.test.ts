import { afterEach, describe, expect, it, vi } from "vitest";
import { cliFetch } from "../core/cli-fetch.js";
import { CLI_USER_AGENT } from "../core/version.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cliFetch", () => {
  it("adds the CLI user agent across supported header input shapes", async () => {
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await cliFetch("https://example.test/plain");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://example.test/plain",
      expect.objectContaining({ headers: { "User-Agent": CLI_USER_AGENT } }),
    );

    await cliFetch("https://example.test/headers", { headers: new Headers({ Accept: "application/json" }) });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://example.test/headers",
      expect.objectContaining({ headers: { accept: "application/json", "User-Agent": CLI_USER_AGENT } }),
    );

    await cliFetch("https://example.test/tuples", { headers: [["X-Test", "1"]] });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://example.test/tuples",
      expect.objectContaining({ headers: { "X-Test": "1", "User-Agent": CLI_USER_AGENT } }),
    );

    await cliFetch("https://example.test/override", { headers: { "user-agent": "custom" } });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://example.test/override",
      expect.objectContaining({ headers: { "user-agent": "custom" } }),
    );
  });
});
