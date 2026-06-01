import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLimit, readStdin } from "../commands/chat/_shared/io.js";
import { isSecretField, printFlat } from "../commands/config/_shared/format.js";

const outputMocks = vi.hoisted(() => ({
  line: vi.fn(),
  fail: vi.fn((code: string, message: string, exitCode: number) => {
    throw new Error(`${code}:${message}:${exitCode}`);
  }),
}));

vi.mock("../core/output.js", () => ({
  print: {
    line: outputMocks.line,
  },
}));

vi.mock("../cli/output.js", () => ({
  fail: outputMocks.fail,
}));

const originalStdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");

class MockStdin extends EventEmitter {
  isTTY = false;
  destroy = vi.fn();
}

function setProcessStdin(stdin: unknown): void {
  Object.defineProperty(process, "stdin", {
    configurable: true,
    value: stdin,
  });
}

beforeEach(() => {
  outputMocks.line.mockClear();
  outputMocks.fail.mockClear();
});

afterEach(() => {
  if (originalStdinDescriptor) {
    Object.defineProperty(process, "stdin", originalStdinDescriptor);
  }
});

describe("config formatting helpers", () => {
  const schema = {
    server: {
      url: { _tag: "field" },
      token: { _tag: "field", options: { secret: true } },
    },
    agent: {
      runtime: {
        _tag: "optional",
        shape: {
          model: { _tag: "field" },
          apiKey: { _tag: "field", options: { secret: true } },
        },
      },
    },
    feature: { _tag: "field" },
  };

  it("detects secret fields across nested and optional schema shapes", () => {
    expect(isSecretField(schema, "server.token")).toBe(true);
    expect(isSecretField(schema, "agent.runtime.apiKey")).toBe(true);
    expect(isSecretField(schema, "server.url")).toBe(false);
    expect(isSecretField(schema, "feature.enabled")).toBe(false);
    expect(isSecretField(schema, "missing.path")).toBe(false);
  });

  it("prints nested config values and masks secrets by default", () => {
    printFlat(
      {
        server: { url: "https://first-tree.example", token: "secret-token" },
        agent: { runtime: { model: "codex", apiKey: "sk-test" } },
        retry: 3,
        tags: ["prod", "dev"],
      },
      schema,
      "",
      false,
    );

    const output = outputMocks.line.mock.calls.map((call) => call[0]).join("");
    expect(output).toContain("server.url");
    expect(output).toContain("https://first-tree.example");
    expect(output).toContain("server.token");
    expect(output).toContain("***");
    expect(output).toContain("agent.runtime.model");
    expect(output).toContain("codex");
    expect(output).toContain("agent.runtime.apiKey");
    expect(output).not.toContain("secret-token");
    expect(output).not.toContain("sk-test");
    expect(output).toContain("retry");
    expect(output).toContain("3");
    expect(output).toContain("tags");
    expect(output).toContain("prod,dev");
  });

  it("prints secret values when explicitly requested", () => {
    printFlat({ server: { token: "secret-token" } }, schema, "", true);

    const output = outputMocks.line.mock.calls.map((call) => call[0]).join("");
    expect(output).toContain("secret-token");
  });
});

describe("chat io helpers", () => {
  it("returns null when stdin is interactive", async () => {
    setProcessStdin({ isTTY: true });

    await expect(readStdin()).resolves.toBeNull();
  });

  it("buffers piped stdin as utf-8 text", async () => {
    const stdin = new MockStdin();
    setProcessStdin(stdin);

    const result = readStdin();
    stdin.emit("data", Buffer.from("hello "));
    stdin.emit("data", Buffer.from("world"));
    stdin.emit("end");

    await expect(result).resolves.toBe("hello world");
    expect(stdin.destroy).not.toHaveBeenCalled();
  });

  it("rejects oversized stdin and destroys the stream", async () => {
    const stdin = new MockStdin();
    setProcessStdin(stdin);

    const result = readStdin();
    stdin.emit("data", Buffer.alloc(5 * 1024 * 1024 + 1));

    await expect(result).rejects.toThrow("stdin exceeds 5242880 bytes");
    expect(stdin.destroy).toHaveBeenCalled();
  });

  it("parses bounded positive limits and fails invalid values", () => {
    expect(parseLimit("25", 100)).toBe(25);
    expect(() => parseLimit("0", 100)).toThrow("INVALID_LIMIT:Limit must be between 1 and 100.:2");
    expect(() => parseLimit("101", 100)).toThrow("INVALID_LIMIT:Limit must be between 1 and 100.:2");
    expect(() => parseLimit("nope", 100)).toThrow("INVALID_LIMIT:Limit must be between 1 and 100.:2");
    expect(outputMocks.fail).toHaveBeenCalledTimes(3);
  });
});
