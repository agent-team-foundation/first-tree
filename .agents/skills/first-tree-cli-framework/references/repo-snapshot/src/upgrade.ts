import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Repo } from "#src/repo.js";

const SEED_TREE_URL = "https://github.com/agent-team-foundation/seed-tree";

function getUpstreamVersion(repo: Repo): string | null {
  try {
    execFileSync("git", ["fetch", "context-tree-upstream", "--depth", "1"], {
      cwd: repo.root,
      encoding: "utf-8",
      stdio: "pipe",
    });
  } catch {
    return null;
  }
  try {
    const result = execFileSync(
      "git",
      ["show", "context-tree-upstream/main:.context-tree/VERSION"],
      { cwd: repo.root, encoding: "utf-8", stdio: "pipe" },
    );
    return result.trim();
  } catch {
    return null;
  }
}

function writeProgress(repo: Repo, content: string): void {
  const progressPath = join(repo.root, ".context-tree", "progress.md");
  mkdirSync(dirname(progressPath), { recursive: true });
  writeFileSync(progressPath, content);
}

export function runUpgrade(): number {
  const repo = new Repo();

  if (!repo.hasFramework()) {
    console.error(
      "Error: no .context-tree/ found. Run `context-tree init` first.",
    );
    return 1;
  }

  const localVersion = repo.readVersion() ?? "unknown";
  console.log(`Local framework version: ${localVersion}\n`);

  // Check for upstream remote
  if (!repo.hasUpstreamRemote()) {
    const lines = [
      "# Context Tree Upgrade\n",
      "## Setup",
      `- [ ] Add upstream remote: \`git remote add context-tree-upstream ${SEED_TREE_URL}\``,
      "- [ ] Then run `context-tree upgrade` again to check for updates",
    ];
    const output = lines.join("\n");
    console.log(output);
    writeProgress(repo, output + "\n");
    console.log("\nProgress file written to .context-tree/progress.md");
    return 0;
  }

  // Fetch upstream version
  const upstreamVersion = getUpstreamVersion(repo);
  if (upstreamVersion === null) {
    console.log(
      "Could not fetch upstream version. Check your network and try again.",
    );
    return 1;
  }

  if (upstreamVersion === localVersion) {
    console.log(`Already up to date (v${localVersion}).`);
    return 0;
  }

  const lines: string[] = [
    `# Context Tree Upgrade — v${localVersion} -> v${upstreamVersion}\n`,
    "## Framework",
    "- [ ] Pull latest from upstream: `git fetch context-tree-upstream && git merge context-tree-upstream/main`",
    "- [ ] Resolve any conflicts in `.context-tree/` (framework files should generally take upstream version)",
    "",
  ];

  // Check AGENT.md
  if (repo.hasAgentMdMarkers()) {
    lines.push(
      "## Agent Instructions",
      "- [ ] Check if AGENT.md framework section needs updating — compare content between markers to the new template",
      "",
    );
  }

  lines.push(
    "## Verification",
    `- [ ] \`.context-tree/VERSION\` reads \`${upstreamVersion}\``,
    "- [ ] `context-tree verify` passes",
    "- [ ] AGENT.md framework section matches upstream",
    "",
    "---",
    "",
    "**Important:** As you complete each task, check it off in" +
      " `.context-tree/progress.md` by changing `- [ ]` to `- [x]`." +
      " Run `context-tree verify` when done — it will fail if any" +
      " items remain unchecked.",
    "",
  );

  const output = lines.join("\n");
  console.log(output);
  writeProgress(repo, output);
  console.log("Progress file written to .context-tree/progress.md");
  return 0;
}
