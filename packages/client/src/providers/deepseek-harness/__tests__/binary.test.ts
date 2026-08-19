import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_INSTALL_NPM_PACKAGE,
  deepseekLaunchFingerprint,
  deepseekSessionRoot,
  formatDeepseekBinaryMissingMessage,
  resolveDeepseekModel,
  resolveDeepseekRuntimeBinary,
} from "../binary.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("DeepSeek binary resolution", () => {
  it("resolves bundled binary and cordis without launching", () => {
    const root = mkdtempSync(join(tmpdir(), "ft-deepseek-bin-"));
    roots.push(root);
    const binary = join(root, "packaged-bin.js");
    const cordis = join(root, "cordis.yml");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    writeFileSync(cordis, "- id: sdk-jsonrpc-server\n");
    chmodSync(binary, 0o755);

    expect(
      resolveDeepseekRuntimeBinary(
        {},
        {
          resolveJsonRpcAgent: () => binary,
          resolveCordisPath: () => cordis,
        },
      ),
    ).toEqual({
      ok: true,
      binary,
      cordisPath: cordis,
      moduleBaseUrl: pathToFileURL(binary).href,
    });
  });

  it("reports a missing bundled runtime with npm install guidance", () => {
    const result = resolveDeepseekRuntimeBinary({}, { resolveJsonRpcAgent: () => null });
    expect(result).toMatchObject({ ok: false, transient: false });
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain(DEEPSEEK_INSTALL_NPM_PACKAGE);
    expect(formatDeepseekBinaryMissingMessage("no binary")).toContain("DeepSeek Harness runtime packages are missing");
  });

  it("defaults empty model to deepseek-v4-flash and session root under agent home", () => {
    expect(resolveDeepseekModel("")).toBe(DEEPSEEK_DEFAULT_MODEL);
    expect(resolveDeepseekModel(" custom-model ")).toBe("custom-model");
    expect(deepseekSessionRoot("/tmp/workspace")).toBe("/tmp/workspace/.first-tree/deepseek-harness-sessions");
    expect(
      deepseekLaunchFingerprint({
        model: "",
        env: [
          { key: "B", value: "2" },
          { key: "A", value: "1" },
        ],
      }),
    ).toBe(
      deepseekLaunchFingerprint({
        model: "deepseek-v4-flash",
        env: [
          { key: "A", value: "1" },
          { key: "B", value: "2" },
        ],
      }),
    );
  });
});
