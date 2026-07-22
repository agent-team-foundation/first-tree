// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

describe("bootstrap auth fragment", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("is memory-only and consumed exactly once", async () => {
    const { consumeBootstrapAuthFragment, installBootstrapAuthFragment } = await import("../bootstrap-fragment.js");
    installBootstrapAuthFragment("#claim=opaque");
    expect(consumeBootstrapAuthFragment()).toBe("#claim=opaque");
    expect(consumeBootstrapAuthFragment()).toBeNull();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});
