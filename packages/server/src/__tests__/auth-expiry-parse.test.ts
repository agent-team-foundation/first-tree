import { describe, expect, it } from "vitest";
import { expiryToSeconds } from "../services/auth.js";

/**
 * The connect-token API surfaces `expiresIn` (seconds) to the Web "+ New
 * Connection" dialog, derived from the configured `connectTokenExpiry`
 * string. A typo in the env var must surface at boot or first request,
 * not as an opaque countdown bug days later in the field.
 *
 * Also doubles as the canonical regression for the `"30s" | "10m" |
 * "30d"` grammar — adding a unit (e.g. `"6mo"`) without updating the
 * parser will fail here loudly.
 */
describe("expiryToSeconds — token-lifetime config parser", () => {
  it.each([
    ["30s", 30],
    ["10m", 600],
    ["2h", 7_200],
    ["1d", 86_400],
    ["30d", 2_592_000],
    ["1w", 604_800],
  ])("parses %s as %d seconds", (input, expected) => {
    expect(expiryToSeconds(input)).toBe(expected);
  });

  it("tolerates inner whitespace (operator-friendly)", () => {
    expect(expiryToSeconds("30 m")).toBe(1_800);
  });

  it("tolerates leading/trailing whitespace from env vars", () => {
    expect(expiryToSeconds("  30d  ")).toBe(2_592_000);
  });

  it.each([
    ["30"], // no unit
    ["30x"], // unknown unit
    ["abc"], // not a number
    [""], // empty
    ["6mo"], // multi-letter unit not supported (months are calendar-dependent anyway)
    ["-30s"], // negative — caller should never receive a "lifetime in the past" string
  ])("rejects malformed input %s", (bad) => {
    expect(() => expiryToSeconds(bad)).toThrow(/Invalid expiry/);
  });
});
