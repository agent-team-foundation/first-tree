import { describe, expect, it } from "vitest";

import { gateCommandFailed } from "../gate-exit.js";

describe("gate command exit behavior", () => {
  it.each(["first-tree-write", "first-tree-welcome"])("keeps default %s gate success when quality is omitted", () => {
    expect(gateCommandFailed({ failed: 0 }, null)).toBe(false);
  });

  it("fails when deterministic gate fails", () => {
    expect(gateCommandFailed({ failed: 1 }, null)).toBe(true);
  });

  it("fails when included quality is skipped or fails", () => {
    expect(
      gateCommandFailed(
        { failed: 0 },
        {
          batch: null,
          skippedReason: "quality was not run because deterministic gate failed",
        },
      ),
    ).toBe(true);
    expect(
      gateCommandFailed(
        { failed: 0 },
        {
          batch: { failed: 1 },
          skippedReason: null,
        },
      ),
    ).toBe(true);
  });
});
