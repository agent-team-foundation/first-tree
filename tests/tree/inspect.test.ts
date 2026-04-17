import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectRepo } from "#products/tree/engine/inspect.js";
import { Repo } from "#products/tree/engine/repo.js";
import {
  CLAUDE_SETTINGS_PATH,
  CODEX_HOOKS_PATH,
} from "#products/tree/engine/runtime/adapters.js";
import {
  makeManagedAgentContext,
  makeSourceRepo,
  useTmpDir,
} from "../helpers.js";

describe("inspectRepo", () => {
  it("returns a detailed current agent context hook report", () => {
    const tmp = useTmpDir();
    makeSourceRepo(tmp.path);
    makeManagedAgentContext(tmp.path);

    const inspection = inspectRepo(new Repo(tmp.path));

    expect(inspection.agentContextHookReport.overall).toBe("current");
    expect(inspection.agentContextHookReport.files).toEqual([
      expect.objectContaining({
        id: "claudeSettings",
        path: CLAUDE_SETTINGS_PATH,
        status: "current",
      }),
      expect.objectContaining({
        id: "codexConfig",
        path: ".codex/config.toml",
        status: "current",
      }),
      expect.objectContaining({
        id: "codexHooks",
        path: CODEX_HOOKS_PATH,
        status: "current",
      }),
    ]);
  });

  it("reports per-file drift and a repair hint", () => {
    const tmp = useTmpDir();
    makeSourceRepo(tmp.path);
    makeManagedAgentContext(tmp.path);
    rmSync(join(tmp.path, CODEX_HOOKS_PATH));
    writeFileSync(
      join(tmp.path, CLAUDE_SETTINGS_PATH),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: ".context-tree/scripts/inject-tree-context.sh",
                },
              ],
            },
          ],
        },
      }, null, 2),
    );

    const inspection = inspectRepo(new Repo(tmp.path));

    expect(inspection.agentContextHookReport.overall).toBe("drifted");
    expect(inspection.agentContextHookReport.repairHint).toContain(
      "first-tree tree upgrade",
    );
    expect(inspection.agentContextHookReport.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "claudeSettings",
          status: "stale",
        }),
        expect.objectContaining({
          id: "codexHooks",
          status: "missing",
        }),
      ]),
    );
  });
});
