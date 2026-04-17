import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const JOIN_USAGE = `usage: first-tree tree join --tree-url <url> --invite <github-id>
       [--branch <name>] [--tree-path <path>] [--skip-install]

Accept a pending invite to a Context Tree.

What it does:
  1. Installs the first-tree CLI globally (if not already installed)
  2. Clones the tree repo
  3. Checks out the branch containing the invite and accepts it
  4. Pushes the acceptance

After this command completes, the tree is available locally and the
agent can read it to determine next steps (workspace setup, skill
installation, etc.) based on your preferences.

Options:
  --tree-url <url>       Remote URL of the tree repo (required)
  --invite <github-id>   GitHub username of the invitee (required)
  --branch <name>        Branch containing the invite (default: invite/<github-id>)
  --tree-path <path>     Local path for the tree repo (default: sibling directory)
  --skip-install         Skip global CLI installation
  --help                 Show this help message
`;

export interface ParsedJoinArgs {
  treeUrl?: string;
  invite?: string;
  branch?: string;
  treePath?: string;
  skipInstall: boolean;
}

export function parseJoinArgs(
  args: string[],
): ParsedJoinArgs | { error: string } {
  const parsed: ParsedJoinArgs = { skipInstall: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--tree-url": {
        const val = args[++i];
        if (!val) return { error: "Missing value for --tree-url" };
        parsed.treeUrl = val;
        break;
      }
      case "--invite": {
        const val = args[++i];
        if (!val) return { error: "Missing value for --invite" };
        parsed.invite = val;
        break;
      }
      case "--branch": {
        const val = args[++i];
        if (!val) return { error: "Missing value for --branch" };
        parsed.branch = val;
        break;
      }
      case "--tree-path": {
        const val = args[++i];
        if (!val) return { error: "Missing value for --tree-path" };
        parsed.treePath = val;
        break;
      }
      case "--skip-install":
        parsed.skipInstall = true;
        break;
      default:
        return { error: `Unknown option: ${arg}` };
    }
  }

  if (!parsed.treeUrl) return { error: "Missing required --tree-url" };
  if (!parsed.invite) return { error: "Missing required --invite" };

  return parsed;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function inferRepoNameFromUrl(url: string): string {
  const scpMatch = url.match(/^.+[:/]([^/]+?)(?:\.git)?$/);
  return scpMatch?.[1] ?? basename(url).replace(/\.git$/, "");
}

function isCliInstalledGlobally(): boolean {
  try {
    execFileSync("first-tree", ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function installCliGlobally(): boolean {
  console.log("  Installing first-tree CLI globally...");
  try {
    execFileSync("npm", ["install", "-g", "first-tree"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    console.log("  first-tree CLI installed.");
    return true;
  } catch {
    console.error(
      "  Warning: could not install first-tree globally. You can install it manually: npm install -g first-tree",
    );
    return false;
  }
}

const STATUS_INVITED_RE = /^status:\s*"?invited"?\s*$/m;

export interface JoinOptions {
  treeUrl: string;
  invite: string;
  branch?: string;
  treePath?: string;
  skipInstall: boolean;
}

export function runJoin(options: JoinOptions): number {
  const { treeUrl, invite, skipInstall } = options;
  const branchName = options.branch?.trim() || `invite/${invite}`;

  console.log("\nJoining Context Tree...\n");

  // --- Step 1: Install CLI globally ---
  if (!skipInstall) {
    if (isCliInstalledGlobally()) {
      console.log("  first-tree CLI already installed.");
    } else {
      installCliGlobally();
    }
  }

  // --- Step 2: Clone tree repo ---
  let treePath: string;
  if (options.treePath) {
    treePath = options.treePath;
  } else {
    const repoName = inferRepoNameFromUrl(treeUrl);
    treePath = resolve(process.cwd(), repoName);
  }

  if (!existsSync(treePath)) {
    console.log(`  Cloning tree repo to ${treePath}...`);
    try {
      git(["clone", treeUrl, treePath], dirname(treePath));
    } catch (err) {
      console.error(
        `Error: could not clone ${treeUrl} — ${err instanceof Error ? err.message : String(err)}`,
      );
      return 1;
    }
  } else {
    console.log(`  Tree repo already exists at ${treePath}, fetching...`);
    try {
      git(["fetch", "origin"], treePath);
    } catch {
      console.error("  Warning: could not fetch from origin (non-fatal)");
    }
  }

  // --- Step 3: Checkout invite branch ---
  try {
    git(["checkout", branchName], treePath);
  } catch {
    try {
      git(["checkout", "-b", branchName, `origin/${branchName}`], treePath);
    } catch {
      console.error(
        `Error: branch '${branchName}' not found locally or on remote. Was the invite created?`,
      );
      return 1;
    }
  }
  console.log(`  Checked out branch ${branchName}`);

  // --- Step 4: Accept invite ---
  const memberNodePath = join(treePath, "members", invite, "NODE.md");
  if (!existsSync(memberNodePath)) {
    console.error(
      `Error: members/${invite}/NODE.md not found on branch '${branchName}'.`,
    );
    return 1;
  }

  const content = readFileSync(memberNodePath, "utf-8");
  if (!STATUS_INVITED_RE.test(content)) {
    console.error(
      `Error: members/${invite}/NODE.md does not have status: invited. The invite may have already been accepted.`,
    );
    return 1;
  }

  const updated = content.replace(/^status:\s*"?invited"?\s*\n/m, "");
  writeFileSync(memberNodePath, updated);

  git(["add", join("members", invite, "NODE.md")], treePath);
  git(
    ["commit", "-m", `docs(members): accept invite for ${invite}`],
    treePath,
  );
  console.log(`  Invite accepted for ${invite}`);

  // --- Step 5: Push ---
  try {
    git(["push", "origin", branchName], treePath);
    console.log(`  Pushed to origin/${branchName}`);
  } catch {
    console.error(
      "  Warning: could not push. You may need to push manually: git push origin " + branchName,
    );
  }

  // --- Summary + agent prompt ---
  console.log("\n" + "=".repeat(50));
  console.log("  Join complete!");
  console.log("=".repeat(50));
  console.log("");
  console.log(`  Tree: ${treePath}`);
  console.log(`  Member node: ${treePath}/members/${invite}/NODE.md`);
  console.log(`  Remote: ${treeUrl}`);
  console.log("");
  console.log("  Next steps for the agent:");
  console.log("  1. Read the tree's root NODE.md and the new member's NODE.md");
  console.log("  2. Check if any of the tree's bound repositories are already");
  console.log("     cloned locally (look at .first-tree/bindings/ for repo names)");
  console.log("  3. Ask the user: would you like to start development? Then suggest");
  console.log("     which repos to clone and how to bind them based on the member's");
  console.log("     domains and the tree's repository list");

  return 0;
}

export function runJoinCli(args: string[] = []): number {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(JOIN_USAGE);
    return 0;
  }

  const parsed = parseJoinArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    console.log(JOIN_USAGE);
    return 1;
  }

  const treePath = parsed.treePath
    ? resolve(process.cwd(), parsed.treePath)
    : undefined;

  return runJoin({
    treeUrl: parsed.treeUrl!,
    invite: parsed.invite!,
    branch: parsed.branch,
    treePath,
    skipInstall: parsed.skipInstall,
  });
}
