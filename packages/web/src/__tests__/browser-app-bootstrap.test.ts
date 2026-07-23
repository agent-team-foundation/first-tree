import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("../browser-app.js");
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("browser CSP bootstrap", () => {
  it("configures Zod jitless before evaluating Shared object schemas", async () => {
    vi.resetModules();
    const originalFunction = globalThis.Function;
    const functionCalls: unknown[][] = [];
    const blockedFunction = function blockedFunction(...args: string[]): never {
      functionCalls.push(args);
      throw new EvalError("Dynamic Function construction is blocked by the browser CSP");
    };
    vi.stubGlobal("Function", blockedFunction as unknown as FunctionConstructor);

    let parsedValue: unknown;
    let jitlessAtAppEvaluation: boolean | undefined;
    const mountBrowserApp = vi.fn();
    vi.doMock("../browser-app.js", async () => {
      const { config } = await import("zod");
      jitlessAtAppEvaluation = config().jitless;
      const { loginSchema } = await import("@first-tree/shared");
      parsedValue = loginSchema.parse({ username: "browser", password: "safe" });
      return { mountBrowserApp };
    });

    const { config } = await import("zod");
    const previousJitless = config().jitless;
    config({ jitless: false });
    try {
      const { startBrowserApp } = await import("../browser-app-bootstrap.js");
      await startBrowserApp();

      expect(jitlessAtAppEvaluation).toBe(true);
      expect(parsedValue).toEqual({ username: "browser", password: "safe" });
      expect(functionCalls).toEqual([]);
      expect(mountBrowserApp).toHaveBeenCalledOnce();
    } finally {
      config({ jitless: previousJitless });
      vi.doUnmock("../browser-app.js");
      vi.unstubAllGlobals();
      vi.resetModules();
      expect(globalThis.Function).toBe(originalFunction);
    }
  });
});
