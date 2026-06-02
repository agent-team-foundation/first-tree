import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execCli } from "../framework/cli-driver/exec.js";
import { runCliJson } from "../framework/cli-json.js";
import { type CurrentRunHandle, readCurrentHandle } from "../framework/current-handle.js";
import { type LocalGitFixture, makeLocalGitFixture } from "../framework/local-git-fixture.js";

/**
 * Direct CLI onboarding e2e — replaces the direct-CLI section of the legacy
 * `e2e/onboarding-smoke.sh` (see issue #725).
 *
 * Scope: pure local CLI behavior. No server contact, no docker (beyond the
 * globalSetup PG + server that other tests rely on). Source repo is a local
 * temp git fixture (`makeLocalGitFixture`) rather than an external clone, so
 * this test does not inherit flake from any demo repo on github.com.
 *
 * Sequence:
 *   1. mv source repo into a freshly-created workspace dir
 *   2. tree init --scope workspace → emits treeRoot (child of workspace root)
 *   3. tree status                 → reports the W1 workspace shape
 *   4. tree verify                 → ok === true
 *   5. tree automation install --tier 2 --dry-run → stage === `write_rule_layer`
 *   6. tree skill doctor           → runs to completion, emits valid JSON
 *
 * File-landing assertions after the chain:
 *   - workspace/AGENTS.md, workspace/CLAUDE.md (workspace-root framework)
 *   - workspace/.first-tree/workspace.json (W1 manifest)
 *   - tree/.github/workflows/validate.yml (first line is the template marker)
 *   - tree/.first-tree/agent-templates/{developer,code-reviewer}.yaml
 *   - tree/.first-tree/org.yaml
 */

type InitResult = { treeRoot: string };
type StatusResult = { workspaceRoot: string; manifest: { tree: string; sources: string[] } };
type VerifyResult = { ok: boolean };
type AutomationDryRunResult = { stage: string };

let handle: CurrentRunHandle;
let fixture: LocalGitFixture;

beforeAll(() => {
  // We don't *use* the world handle here — the test is local-CLI only — but
  // reading it forces an explicit setup failure if globalSetup did not run,
  // instead of the test silently succeeding against whatever happens to be
  // on disk.
  handle = readCurrentHandle();
  fixture = makeLocalGitFixture();
});

afterAll(() => {
  fixture?.cleanup();
});

describe("direct CLI onboarding — local fixture, no external clone", () => {
  it("walks init → status → verify → skill doctor against a fresh source repo", async () => {
    const sourceRepo = fixture.repoRoot;
    const sourceName = basename(sourceRepo);
    const workspaceRoot = resolve(dirname(sourceRepo), `${sourceName}-workspace`);
    mkdirSync(workspaceRoot, { recursive: true });
    const movedSource = resolve(workspaceRoot, sourceName);
    renameSync(sourceRepo, movedSource);

    const treeName = `${sourceName}-tree`;
    const cliEnv = { home: handle.clientHome, serverBaseUrl: handle.serverBaseUrl };

    const init = await runCliJson<InitResult>({
      ...cliEnv,
      cwd: workspaceRoot,
      args: [
        "tree",
        "init",
        "--json",
        "--scope",
        "workspace",
        "--tree-path",
        `./${treeName}`,
        "--tree-mode",
        "dedicated",
      ],
    });
    expect(init.json.treeRoot, "tree init should report a treeRoot path").toBeTruthy();
    const treeRoot = init.json.treeRoot;

    const status = await runCliJson<StatusResult>({
      ...cliEnv,
      cwd: workspaceRoot,
      args: ["tree", "status", "--json"],
    });
    expect(status.json.workspaceRoot, "status should report the workspace root").toBe(workspaceRoot);
    expect(status.json.manifest.tree, "status manifest.tree should match the tree subdir name").toBe(treeName);

    const verify = await runCliJson<VerifyResult>({
      ...cliEnv,
      cwd: workspaceRoot,
      args: ["tree", "verify", "--json", "--tree-path", treeRoot],
    });
    expect(verify.json.ok, "tree verify should report ok=true on a freshly onboarded tree").toBe(true);

    const automation = await runCliJson<AutomationDryRunResult>({
      ...cliEnv,
      cwd: workspaceRoot,
      args: ["tree", "automation", "install", "--tier", "2", "--tree-path", treeRoot, "--dry-run", "--json"],
    });
    expect(automation.json.stage, "automation install --dry-run should report stage=write_rule_layer").toBe(
      "write_rule_layer",
    );

    // skill doctor: mirror the legacy bash semantics — capture stdout and
    // confirm it is valid JSON, but do NOT gate on exit code. Doctor exits
    // non-zero when shipped skill payloads are out of sync, which is a real
    // signal worth surfacing but is not the contract this test pins (Phase B
    // will add a dedicated skill-doctor health test).
    const doctor = await execCli({
      ...cliEnv,
      cwd: workspaceRoot,
      args: ["tree", "skill", "doctor", "--json", "--root", workspaceRoot],
    });
    expect(doctor.stdout.trim(), "skill doctor should emit JSON to stdout").not.toBe("");
    expect(() => JSON.parse(doctor.stdout), `skill doctor stdout was not valid JSON:\n${doctor.stdout}`).not.toThrow();

    // Workspace root: framework files + W1 manifest land here, not in the source.
    expect(existsSync(resolve(workspaceRoot, "AGENTS.md")), "AGENTS.md should be written at the workspace root").toBe(
      true,
    );
    expect(existsSync(resolve(workspaceRoot, "CLAUDE.md")), "CLAUDE.md should be written at the workspace root").toBe(
      true,
    );
    expect(
      existsSync(resolve(workspaceRoot, ".first-tree/workspace.json")),
      "workspace.json manifest should be written at the workspace root",
    ).toBe(true);

    // Tree repo: workflow + agent templates + org config land on the tree side.
    const validateYml = resolve(treeRoot, ".github/workflows/validate.yml");
    expect(existsSync(validateYml), "validate.yml should be written into the tree repo").toBe(true);
    const firstLine = readFileSync(validateYml, "utf8").split(/\r?\n/, 1)[0];
    expect(firstLine, "validate.yml first line must be the managed template marker").toBe(
      "# first-tree-template-version: 2",
    );

    expect(
      existsSync(resolve(treeRoot, ".first-tree/agent-templates/developer.yaml")),
      "developer.yaml agent template should be written into the tree repo",
    ).toBe(true);
    expect(
      existsSync(resolve(treeRoot, ".first-tree/agent-templates/code-reviewer.yaml")),
      "code-reviewer.yaml agent template should be written into the tree repo",
    ).toBe(true);
    expect(existsSync(resolve(treeRoot, ".first-tree/org.yaml")), "org.yaml should be written into the tree repo").toBe(
      true,
    );
  });
});
