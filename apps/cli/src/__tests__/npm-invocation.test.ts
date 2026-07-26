import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveNpmInvocation } from "../core/npm-invocation.js";

describe("npm invocation resolution", () => {
  it("runs npm-cli.js with node.exe on Windows instead of spawning npm.cmd", () => {
    const execPath = join("C:\\Program Files", "nodejs", "node.exe");
    const npmCli = join(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js");
    const invocation = resolveNpmInvocation(["--version"], {
      platform: "win32",
      execPath,
      pathExists: (path) => path === npmCli,
    });

    expect(invocation).toEqual({
      command: execPath,
      args: [npmCli, "--version"],
      shell: false,
    });
  });

  it("uses a PATH shell fallback for non-standard Windows Node layouts", () => {
    expect(
      resolveNpmInvocation(["--version"], {
        platform: "win32",
        execPath: join("C:\\custom-node", "node.exe"),
        pathExists: () => false,
      }),
    ).toEqual({ command: "npm", args: ["--version"], shell: true });
  });

  it.runIf(process.platform === "win32")("executes the real sibling npm CLI on Windows", () => {
    const invocation = resolveNpmInvocation(["--version"]);
    const result = spawnSync(invocation.command, invocation.args, {
      encoding: "utf-8",
      shell: invocation.shell,
      timeout: 10_000,
      windowsHide: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
