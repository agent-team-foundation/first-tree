// @vitest-environment node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const WEB_ROOT = new URL("../../../../", import.meta.url);

describe("Orientation voiceover authoring", () => {
  it("keeps the generated review script and captions synchronized with chapters.json", async () => {
    const result = await execFileAsync(process.execPath, ["scripts/build-orientation-voiceovers.mjs", "--check"], {
      cwd: WEB_ROOT,
    });

    expect(result.stdout).toContain("source, review script, and captions are synchronized");
  });
});
