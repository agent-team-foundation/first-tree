import { describe, expect, it } from "vitest";

import { AUTO_USAGE, runAuto, type Output } from "../src/index.js";

describe("runAuto entry", () => {
  it("re-exports the cli runAuto and AUTO_USAGE", async () => {
    expect(typeof runAuto).toBe("function");
    expect(typeof AUTO_USAGE).toBe("string");
    expect(AUTO_USAGE).toContain("first-tree auto");
  });

  it("matches the (args, output) => Promise<number> signature", async () => {
    const result: Promise<number> = runAuto([], () => {});
    expect(typeof (await result)).toBe("number");

    type Signature = Parameters<typeof runAuto>;
    const _argsType: Signature = [[], () => {}];
    void _argsType;
  });

  it("prints AUTO_USAGE for bare invocation", async () => {
    const lines: string[] = [];
    const output: Output = (text) => lines.push(text);

    const exitCode = await runAuto([], output);

    expect(exitCode).toBe(0);
    expect(lines).toEqual([AUTO_USAGE]);
  });
});
