import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfigPayload } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionContext } from "../runtime/handler.js";
import {
  buildResourceSkillsBriefing,
  materializeResourceSkills,
  resourceSkillPath,
} from "../runtime/resource-skills.js";

const payload: AgentRuntimeConfigPayload = {
  kind: "claude-code",
  prompt: { append: "" },
  model: "",
  mcpServers: [],
  env: [],
  gitRepos: [],
  resourceSkills: [
    {
      resourceId: "res-skill-1",
      name: "review",
      description: "Review code risks first.",
      body: "# Review\n\nCheck correctness before style.",
      metadata: { owner: "platform" },
    },
  ],
  reasoningEffort: "",
};

describe("resource skill materialization", () => {
  let workspace: string | undefined;

  afterEach(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true });
    workspace = undefined;
  });

  it("writes resource skills and exposes their paths in the runtime briefing", async () => {
    workspace = await mkdtemp(join(tmpdir(), "ft-resource-skills-"));
    const log = vi.fn();
    await materializeResourceSkills(workspace, payload, { log } as unknown as SessionContext);

    const target = resourceSkillPath(workspace, "res-skill-1");
    const body = await readFile(target, "utf-8");
    expect(body).toContain('name: "review"');
    expect(body).toContain('description: "Review code risks first."');
    expect(body).toContain("# Review");
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`Resource skill materialized: review -> ${target}`));

    const briefing = buildResourceSkillsBriefing(workspace, payload);
    expect(briefing).toContain("## Team Skills");
    expect(briefing).toContain("- review: Review code risks first.");
    expect(briefing).toContain(`Path: ${target}`);
  });

  it("prunes stale resource skill directories", async () => {
    workspace = await mkdtemp(join(tmpdir(), "ft-resource-skills-"));
    const log = vi.fn();
    await materializeResourceSkills(workspace, payload, { log } as unknown as SessionContext);
    const target = resourceSkillPath(workspace, "res-skill-1");
    expect(await readFile(target, "utf-8")).toContain('name: "review"');

    await materializeResourceSkills(workspace, { ...payload, resourceSkills: [] }, {
      log,
    } as unknown as SessionContext);

    await expect(readFile(target, "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Resource skill pruned:"));
  });

  it("quotes frontmatter scalars", async () => {
    workspace = await mkdtemp(join(tmpdir(), "ft-resource-skills-"));
    await materializeResourceSkills(
      workspace,
      {
        ...payload,
        resourceSkills: [
          {
            resourceId: "res-skill-quote",
            name: "review:ops",
            description: "Line one\n---\nline two",
            body: "# Body",
            metadata: {},
          },
        ],
      },
      { log: vi.fn() } as unknown as SessionContext,
    );

    const body = await readFile(resourceSkillPath(workspace, "res-skill-quote"), "utf-8");
    expect(body).toContain('name: "review:ops"');
    expect(body).toContain('description: "Line one\\n---\\nline two"');
  });
});
