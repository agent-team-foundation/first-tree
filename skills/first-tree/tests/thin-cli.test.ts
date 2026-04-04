import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { USAGE, runCli } from "../../../src/cli.ts";

const ROOT = process.cwd();

function captureOutput(): { lines: string[]; write: (text: string) => void } {
  const lines: string[] = [];
  return {
    lines,
    write: (text: string) => {
      lines.push(text);
    },
  };
}

describe("thin CLI shell", () => {
  it("prints usage with no args", async () => {
    const output = captureOutput();

    const code = await runCli([], output.write);

    expect(code).toBe(0);
    expect(output.lines).toEqual([USAGE]);
  });

  it("prints the package version", async () => {
    const output = captureOutput();
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
      version: string;
    };

    const code = await runCli(["--version"], output.write);

    expect(code).toBe(0);
    expect(output.lines).toEqual([pkg.version]);
  });

  it("routes help onboarding through the CLI entrypoint", async () => {
    const output = captureOutput();

    const code = await runCli(["help", "onboarding"], output.write);

    expect(code).toBe(0);
    expect(output.lines.join("\n")).toContain("# Context Tree Onboarding");
    expect(output.lines.join("\n")).toContain("Node.js 18+");
  });

  it("fails with usage for an unknown command", async () => {
    const output = captureOutput();

    const code = await runCli(["wat"], output.write);

    expect(code).toBe(1);
    expect(output.lines[0]).toBe("Unknown command: wat");
    expect(output.lines[1]).toBe(USAGE);
  });
});
