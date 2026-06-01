import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
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
 *   1. tree inspect       → role must be `unbound-source-repo`
 *   2. tree init           → emits treeRoot (sibling dedicated tree dir)
 *   3. tree inspect        → role must be `source-repo-bound`
 *   4. tree verify         → ok === true
 *   5. tree automation install --tier 2 --dry-run → stage === `write_rule_layer`
 *   6. tree skill doctor   → runs to completion, emits valid JSON
 *
 * File-landing assertions after the chain:
 *   - source/AGENTS.md, source/CLAUDE.md (source repo gets the managed block)
 *   - tree/.github/workflows/validate.yml (first line is the template marker)
 *   - tree/.first-tree/agent-templates/{developer,code-reviewer}.yaml
 *   - tree/.first-tree/org.yaml
 */

type InspectResult = { role: string };
type InitResult = { treeRoot: string };
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
  it("walks inspect → init → verify → skill doctor against a fresh source repo", async () => {
    const cwd = fixture.repoRoot;
    const cliEnv = { home: handle.clientHome, serverBaseUrl: handle.serverBaseUrl };

    const before = await runCliJson<InspectResult>({
      ...cliEnv,
      cwd,
      args: ["tree", "inspect", "--json"],
    });
    expect(before.json.role, "fresh fixture should report as unbound-source-repo before init").toBe(
      "unbound-source-repo",
    );

    const init = await runCliJson<InitResult>({
      ...cliEnv,
      cwd,
      args: ["tree", "init", "--json", "--no-recursive"],
    });
    expect(init.json.treeRoot, "tree init should report a treeRoot path").toBeTruthy();
    const treeRoot = init.json.treeRoot;

    const after = await runCliJson<InspectResult>({
      ...cliEnv,
      cwd,
      args: ["tree", "inspect", "--json"],
    });
    expect(after.json.role, "source repo should be bound after tree init").toBe("source-repo-bound");

    const verify = await runCliJson<VerifyResult>({
      ...cliEnv,
      cwd,
      args: ["tree", "verify", "--json", "--tree-path", treeRoot],
    });
    expect(verify.json.ok, "tree verify should report ok=true on a freshly onboarded tree").toBe(true);

    const automation = await runCliJson<AutomationDryRunResult>({
      ...cliEnv,
      cwd,
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
      cwd,
      args: ["tree", "skill", "doctor", "--json", "--root", cwd],
    });
    expect(doctor.stdout.trim(), "skill doctor should emit JSON to stdout").not.toBe("");
    expect(() => JSON.parse(doctor.stdout), `skill doctor stdout was not valid JSON:\n${doctor.stdout}`).not.toThrow();

    // Source repo: managed-block files land on the source side.
    expect(existsSync(resolve(cwd, "AGENTS.md")), "AGENTS.md should be written into the source repo").toBe(true);
    expect(existsSync(resolve(cwd, "CLAUDE.md")), "CLAUDE.md should be written into the source repo").toBe(true);

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
