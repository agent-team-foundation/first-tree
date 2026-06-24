import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const WRAPPER_PATH = resolve(HERE, "../../bin/first-tree.cjs");
const WRAPPER_SOURCE = readFileSync(WRAPPER_PATH, "utf-8");

type WrapperRun = {
  exitCode: number | null;
  loadedSpecifier: string | null;
  stderr: string[];
};

function runWrapperWithNode(version: string): WrapperRun {
  const stderr: string[] = [];
  let exitCode: number | null = null;
  let loadedSpecifier: string | null = null;

  const processShim = {
    versions: { node: version },
    exit(code?: number): never {
      exitCode = code ?? 0;
      throw new Error(`process.exit:${exitCode}`);
    },
  };
  const consoleShim = {
    error(message: unknown): void {
      stderr.push(String(message));
    },
  };
  function FunctionShim(): (specifier: string) => Promise<void> {
    return (specifier: string) => {
      loadedSpecifier = specifier;
      return Promise.resolve();
    };
  }

  try {
    runInNewContext(
      WRAPPER_SOURCE,
      {
        console: consoleShim,
        Function: FunctionShim,
        Number,
        process: processShim,
        String,
      },
      { filename: WRAPPER_PATH },
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("process.exit:")) {
      return { exitCode, loadedSpecifier, stderr };
    }
    throw error;
  }

  return { exitCode, loadedSpecifier, stderr };
}

describe("CLI bin wrapper", () => {
  it("prints a clear preflight error before loading the bundled CLI on Node <18.14.1", () => {
    for (const version of ["17.9.1", "18.13.0", "18.14.0"]) {
      const result = runWrapperWithNode(version);

      expect(result.exitCode).toBe(1);
      expect(result.loadedSpecifier).toBeNull();
      expect(result.stderr.join("\n")).toContain("First Tree requires Node.js >=18.14.1.");
    }
  });

  it("loads the bundled CLI entrypoint on Node 18.14.1 and newer", () => {
    for (const version of ["18.14.1", "18.15.0", "20.0.0"]) {
      const result = runWrapperWithNode(version);

      expect(result.exitCode).toBeNull();
      expect(result.stderr).toEqual([]);
      expect(result.loadedSpecifier).toBe("../dist/cli/index.mjs");
    }
  });
});
