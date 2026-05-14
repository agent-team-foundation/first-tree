import { describe, expect, it } from "vitest";
import { formatElapsed } from "../working-chip.js";

describe("formatElapsed — WorkingChip ticker formatter", () => {
  it("sub-second values render with a tenths decimal", () => {
    expect(formatElapsed(0)).toBe("0.0s");
    expect(formatElapsed(400)).toBe("0.4s");
    expect(formatElapsed(999)).toBe("1.0s"); // rounded by toFixed(1)
  });

  it("1s..59s render as integer seconds without a decimal", () => {
    expect(formatElapsed(1000)).toBe("1s");
    expect(formatElapsed(12_500)).toBe("12s");
    expect(formatElapsed(59_999)).toBe("59s");
  });

  it("60s+ render as Mm SSs with zero-padded seconds", () => {
    expect(formatElapsed(60_000)).toBe("1m00s");
    expect(formatElapsed(83_000)).toBe("1m23s");
    expect(formatElapsed(3_600_000)).toBe("60m00s");
  });

  it("negative values clamp to 0s (clock skew safety)", () => {
    expect(formatElapsed(-1)).toBe("0s");
    expect(formatElapsed(-5_000)).toBe("0s");
  });
});
