import type { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../commands/types.js";

const output = vi.hoisted(() => ({ hook: vi.fn() }));

vi.mock("../core/output.js", () => ({ print: output }));

import { runContextObserveLoaded } from "../commands/context/observe-loaded.js";

describe("retired context observe-loaded command", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps an already-loaded adapter 1.0.1 hook as a pure no-op", () => {
    runContextObserveLoaded(context());

    expect(output.hook).toHaveBeenCalledWith({ continue: true });
  });
});

function context(): CommandContext {
  return {
    command: {
      opts: () => ({
        provider: "claude-code",
        adapterDigest: `sha256:${"a".repeat(64)}`,
        adoptionGeneration: "b".repeat(48),
      }),
    } as unknown as Command,
    options: { json: false, debug: false, quiet: false },
  };
}
