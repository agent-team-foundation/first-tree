import { describe, expect, it, vi } from "vitest";

const fail = vi.hoisted(() =>
  vi.fn((code: string, message: string, exitCode: number, metadata?: unknown) => {
    throw Object.assign(new Error(message), { code, exitCode, metadata });
  }),
);

vi.mock("../core/output.js", () => ({ print: { fail } }));

import { runLegacyContextRead } from "../commands/context/legacy-read.js";

describe("legacy Context read tombstone", () => {
  it("fails closed with one typed reload action and never runs a read workflow", () => {
    expect(() => runLegacyContextRead({} as never)).toThrow(
      expect.objectContaining({
        code: "CONTEXT_PLUGIN_RELOAD_REQUIRED",
        exitCode: 2,
        metadata: { nextActions: [expect.stringContaining("Reload the First Tree Context Plugin")] },
      }),
    );
    expect(fail).toHaveBeenCalledOnce();
  });
});
