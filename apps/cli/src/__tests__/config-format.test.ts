import { beforeEach, describe, expect, it, vi } from "vitest";

const printLineMock = vi.fn();

async function loadFormat() {
  vi.doMock("../core/output.js", () => ({
    print: { line: printLineMock },
  }));
  return import("../commands/config/_shared/format.js");
}

describe("config format helpers", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("detects secret fields through optional schema wrappers", async () => {
    const { isSecretField } = await loadFormat();
    const schema = {
      server: {
        token: { _tag: "field", options: { secret: true } },
        url: { _tag: "field" },
      },
      adapter: {
        _tag: "optional",
        shape: {
          secret: { _tag: "field", options: { secret: true } },
        },
      },
    };

    expect(isSecretField(schema, "server.token")).toBe(true);
    expect(isSecretField(schema, "server.url")).toBe(false);
    expect(isSecretField(schema, "adapter.secret")).toBe(true);
    expect(isSecretField(schema, "adapter.missing")).toBe(false);
    expect(isSecretField({ leaf: { _tag: "field" } }, "leaf.child")).toBe(false);
  });

  it("prints nested config values while masking secrets unless requested", async () => {
    const { printFlat } = await loadFormat();
    const schema = {
      server: {
        token: { _tag: "field", options: { secret: true } },
        url: { _tag: "field" },
      },
    };
    const config = {
      server: {
        token: "secret-token",
        url: "https://hub.example.test",
      },
      enabled: true,
    };

    printFlat(config, schema, "", false);
    let printed = printLineMock.mock.calls.flat().join("");
    expect(printed).toContain("server.token");
    expect(printed).toContain("***");
    expect(printed).not.toContain("secret-token");
    expect(printed).toContain("enabled");
    expect(printed).toContain("true");

    printLineMock.mockClear();
    printFlat(config, schema, "", true);
    printed = printLineMock.mock.calls.flat().join("");
    expect(printed).toContain("secret-token");
  });
});
