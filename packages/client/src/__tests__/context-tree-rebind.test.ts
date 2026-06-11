import { describe, expect, it, vi } from "vitest";
import { reresolveUnboundTree } from "../runtime/context-tree-rebind.js";

const BINDING = { path: "/clones/abc", repoUrl: "https://github.com/acme/ct", branch: "main" };

describe("reresolveUnboundTree", () => {
  it("re-resolves when currently unbound (undefined path)", async () => {
    expect(await reresolveUnboundTree(undefined, async () => BINDING)).toEqual(BINDING);
  });

  it("treats an empty-string path as unbound and re-resolves", async () => {
    expect(await reresolveUnboundTree("", async () => BINDING)).toEqual(BINDING);
  });

  it("does NOT re-resolve when already bound (steady state untouched)", async () => {
    const resolve = vi.fn();
    expect(await reresolveUnboundTree("/already/bound", resolve)).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("returns null when the org has no tree configured yet", async () => {
    expect(await reresolveUnboundTree(undefined, async () => null)).toBeNull();
  });

  it("swallows a resolver failure and returns null (session starts unbound)", async () => {
    expect(
      await reresolveUnboundTree(undefined, async () => {
        throw new Error("network down");
      }),
    ).toBeNull();
  });
});
