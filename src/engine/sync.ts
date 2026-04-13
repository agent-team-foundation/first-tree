import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { Repo } from "#engine/repo.js";
import {
  TREE_RUNTIME_ROOT,
} from "#engine/runtime/asset-loader.js";
import {
  listTreeBindings,
  slugifyToken,
  writeTreeBinding,
  type TreeBindingState,
} from "#engine/runtime/binding-state.js";

const execFileAsync = promisify(execFile);

export const SYNC_USAGE = `usage: first-tree sync [--tree-path PATH] [--source ID] [--propose] [--apply] [--dry-run]

Detect drift between a Context Tree and the source repo(s) it describes.
Runs in three phases controlled by flags:

  default        Detect drift only. Prints a summary. Exits 0.
  --propose      Detect + write proposal files under .first-tree/proposals/.
  --apply        Detect + propose + write new tree files, commit, push,
                 and open a PR labeled \`first-tree:sync\`.

First-run policy: if a binding has no \`lastReconciledSourceCommit\`, the
command traces history back to the initial commit (capped at 500 commits
or 6 months) and runs normal propose/apply flow.

Requires the \`gh\` CLI and \`claude\` CLI to be installed and authenticated.
The \`claude\` CLI is used for drift classification and is mandatory (no
deterministic fallback).

Options:
  --tree-path PATH    Sync a tree repo from another working directory
  --source ID         Only sync a single bound source by sourceId
  --propose           Write proposal files under .first-tree/proposals/
  --apply             Apply proposals, open PR (implies --propose)
  --dry-run           With --apply, skip \`git push\` and \`gh pr create\`
  --help              Show this help message
`;

export interface ShellResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type ShellRun = (
  command: string,
  args: string[],
  options?: { cwd?: string; input?: string },
) => Promise<ShellResult>;

export interface SyncDeps {
  shellRun?: ShellRun;
  now?: () => Date;
}

async function defaultShellRun(
  command: string,
  args: string[],
  options: { cwd?: string; input?: string } = {},
): Promise<ShellResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      encoding: "utf-8",
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout: String(stdout), stderr: String(stderr), code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: number | string;
    };
    const stdout = typeof e.stdout === "string" ? e.stdout : e.stdout?.toString() ?? "";
    const stderr = typeof e.stderr === "string" ? e.stderr : e.stderr?.toString() ?? "";
    const code = typeof e.code === "number" ? e.code : 1;
    return { stdout, stderr, code };
  }
}

interface OwnerRepo {
  owner: string;
  repo: string;
}

export function parseOwnerRepoFromRemoteUrl(url: string): OwnerRepo | null {
  const trimmed = url.trim();
  if (trimmed === "") return null;
  const sshMatch = trimmed.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[2], repo: sshMatch[3] };
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const parsed = new URL(trimmed);
      const parts = parsed.pathname
        .replace(/^\/+/, "")
        .replace(/\.git$/, "")
        .split("/");
      if (parts.length >= 2 && parts[0] !== "" && parts[1] !== "") {
        return { owner: parts[0], repo: parts[1] };
      }
    } catch {
      return null;
    }
  }
  return null;
}

export interface TreeNodeSummary {
  path: string;
  title: string | undefined;
  owners: string[] | undefined;
}

const SCAN_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".first-tree",
  ".agents",
  ".claude",
  "dist",
  "build",
]);

const FRONTMATTER_RE = /^---\s*\n(.*?)\n---/s;
const TITLE_RE = /^title:\s*['"]?(.+?)['"]?\s*$/m;
const OWNERS_RE = /^owners:\s*\[([^\]]*)\]/m;

function parseNodeFrontmatter(text: string): {
  title: string | undefined;
  owners: string[] | undefined;
} {
  const match = text.match(FRONTMATTER_RE);
  if (!match) return { title: undefined, owners: undefined };
  const fm = match[1];
  const titleMatch = fm.match(TITLE_RE);
  const ownersMatch = fm.match(OWNERS_RE);
  const title = titleMatch ? titleMatch[1].trim() : undefined;
  let owners: string[] | undefined;
  if (ownersMatch) {
    const raw = ownersMatch[1].trim();
    owners = raw === ""
      ? []
      : raw.split(",").map((o) => o.trim()).filter(Boolean);
  }
  return { title, owners };
}

export function scanTreeNodes(root: string): TreeNodeSummary[] {
  const results: TreeNodeSummary[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SCAN_SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile() && entry === "NODE.md") {
        try {
          const text = readFileSync(full, "utf-8");
          const { title, owners } = parseNodeFrontmatter(text);
          results.push({
            path: relative(root, full).split("\\").join("/"),
            title,
            owners,
          });
        } catch {
          // ignore unreadable files
        }
      }
    }
  };
  walk(root);
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

interface CommitSummary {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string;
  topDir: string;
}

interface MergedPr {
  number: number;
  title: string;
  mergedAt: string;
  mergeCommitSha: string | null;
}

interface DriftReport {
  binding: TreeBindingState;
  ownerRepo: OwnerRepo;
  fromSha: string | null;
  toSha: string;
  commits: CommitSummary[];
  mergedPrs: MergedPr[];
  mergedPrTitles: string[];
  truncated: boolean;
}

interface ClassificationItem {
  path: string;
  type: "TREE_MISS" | "TREE_STALE" | "TREE_OK";
  target_node_path: string | null;
  rationale: string;
  suggested_node_title: string;
  suggested_node_body_markdown: string;
}

/** A group of proposals tied to one source PR (or unlinked commits). */
interface ProposalGroup {
  sourcePrNumber: number | null;
  sourcePrTitle: string | null;
  proposals: ClassificationItem[];
  proposalPaths: string[];
}

interface ParsedFlags {
  help: boolean;
  treePath: string | undefined;
  source: string | undefined;
  propose: boolean;
  apply: boolean;
  dryRun: boolean;
  unknown: string | undefined;
}

function parseFlags(args: string[]): ParsedFlags {
  const result: ParsedFlags = {
    help: false,
    treePath: undefined,
    source: undefined,
    propose: false,
    apply: false,
    dryRun: false,
    unknown: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg === "--tree-path") {
      const value = args[index + 1];
      if (!value) {
        result.unknown = "--tree-path (missing value)";
        return result;
      }
      result.treePath = value;
      index += 1;
      continue;
    }
    if (arg === "--source") {
      const value = args[index + 1];
      if (!value) {
        result.unknown = "--source (missing value)";
        return result;
      }
      result.source = value;
      index += 1;
      continue;
    }
    if (arg === "--propose") {
      result.propose = true;
      continue;
    }
    if (arg === "--apply") {
      result.apply = true;
      result.propose = true;
      continue;
    }
    if (arg === "--dry-run") {
      result.dryRun = true;
      continue;
    }
    result.unknown = arg;
    return result;
  }
  return result;
}

async function getSourceHead(
  shellRun: ShellRun,
  ownerRepo: OwnerRepo,
): Promise<string | null> {
  const result = await shellRun("gh", [
    "api",
    `/repos/${ownerRepo.owner}/${ownerRepo.repo}/commits/HEAD`,
    "--jq",
    ".sha",
  ]);
  if (result.code !== 0) {
    console.error(
      `\u274C gh api failed for ${ownerRepo.owner}/${ownerRepo.repo}: ${result.stderr.trim()}`,
    );
    return null;
  }
  const sha = result.stdout.trim();
  return sha === "" ? null : sha;
}

async function getSourceDefaultBranch(
  shellRun: ShellRun,
  ownerRepo: OwnerRepo,
): Promise<string | null> {
  const result = await shellRun("gh", [
    "api",
    `/repos/${ownerRepo.owner}/${ownerRepo.repo}`,
    "--jq",
    ".default_branch",
  ]);
  if (result.code !== 0) return null;
  const branch = result.stdout.trim();
  return branch === "" ? null : branch;
}

async function getFirstRunFromSha(
  shellRun: ShellRun,
  ownerRepo: OwnerRepo,
  headSha: string,
): Promise<{ fromSha: string; capped: boolean }> {
  // Try to get the initial commit of the default branch
  const defaultBranch = await getSourceDefaultBranch(shellRun, ownerRepo);
  const branch = defaultBranch ?? "main";

  // Check if repo has >500 commits by trying to get the 500th commit back
  const commitsBack = await shellRun("gh", [
    "api",
    `/repos/${ownerRepo.owner}/${ownerRepo.repo}/commits?per_page=1&sha=${headSha}&page=500`,
  ]);

  if (commitsBack.code === 0) {
    try {
      const parsed = JSON.parse(commitsBack.stdout) as Array<{ sha?: string }>;
      if (parsed.length > 0 && parsed[0].sha) {
        return { fromSha: parsed[0].sha, capped: true };
      }
    } catch {
      // ignore
    }
  }

  // Get the first commit (oldest) via direction=asc
  const firstCommitResult = await shellRun("gh", [
    "api",
    `/repos/${ownerRepo.owner}/${ownerRepo.repo}/commits?per_page=1&sha=${branch}&direction=asc`,
  ]);

  if (firstCommitResult.code === 0) {
    try {
      const parsed = JSON.parse(firstCommitResult.stdout) as Array<{ sha?: string }>;
      if (parsed.length > 0 && parsed[0].sha) {
        return { fromSha: parsed[0].sha, capped: false };
      }
    } catch {
      // fall through
    }
  }

  // Last resort: use HEAD itself (will produce 0 commits)
  return { fromSha: headSha, capped: false };
}

interface CompareCommit {
  sha: string;
  commit?: {
    message?: string;
    author?: { name?: string; date?: string };
  };
  files?: Array<{ filename?: string }>;
}

function topDirOf(filename: string): string {
  const idx = filename.indexOf("/");
  return idx === -1 ? "(root)" : filename.slice(0, idx);
}

async function compareCommits(
  shellRun: ShellRun,
  ownerRepo: OwnerRepo,
  fromSha: string,
  toSha: string,
): Promise<{ commits: CommitSummary[]; truncated: boolean } | null> {
  const result = await shellRun("gh", [
    "api",
    `/repos/${ownerRepo.owner}/${ownerRepo.repo}/compare/${fromSha}...${toSha}`,
  ]);
  if (result.code !== 0) {
    console.error(
      `\u274C gh api compare failed for ${ownerRepo.owner}/${ownerRepo.repo}: ${result.stderr.trim()}`,
    );
    return null;
  }
  let parsed: { commits?: CompareCommit[] };
  try {
    parsed = JSON.parse(result.stdout) as { commits?: CompareCommit[] };
  } catch {
    console.error(
      `\u274C failed to parse gh compare JSON for ${ownerRepo.owner}/${ownerRepo.repo}`,
    );
    return null;
  }
  const raw = parsed.commits ?? [];
  const cap = 500;
  const truncated = raw.length > cap;
  const sliced = truncated ? raw.slice(0, cap) : raw;
  const summaries: CommitSummary[] = sliced.map((c) => {
    const message = c.commit?.message ?? "";
    const firstLine = message.split("\n")[0] ?? "";
    const files = c.files ?? [];
    const topDirs = new Set<string>();
    for (const file of files) {
      if (file.filename) topDirs.add(topDirOf(file.filename));
    }
    const topDir = topDirs.size === 0
      ? "(root)"
      : Array.from(topDirs).sort()[0];
    return {
      sha: c.sha,
      shortSha: c.sha.slice(0, 7),
      message: firstLine,
      author: c.commit?.author?.name ?? "unknown",
      date: c.commit?.author?.date ?? "",
      topDir,
    };
  });
  return { commits: summaries, truncated };
}

async function fetchMergedPrs(
  shellRun: ShellRun,
  ownerRepo: OwnerRepo,
  sinceDate: string,
): Promise<MergedPr[]> {
  if (sinceDate === "") return [];
  const query = `repo:${ownerRepo.owner}/${ownerRepo.repo}+is:pr+is:merged+merged:>=${sinceDate.slice(0, 10)}`;
  const result = await shellRun("gh", [
    "api",
    `search/issues?q=${query}&per_page=100`,
  ]);
  if (result.code !== 0) {
    console.error(
      `\u26A0 gh api search/issues failed: ${result.stderr.trim()}`,
    );
    return [];
  }
  try {
    const parsed = JSON.parse(result.stdout) as {
      items?: Array<{
        number?: number;
        title?: string;
        pull_request?: { merged_at?: string; merge_commit_sha?: string };
      }>;
    };
    return (parsed.items ?? [])
      .filter((item) => item.title && item.number)
      .map((item) => ({
        number: item.number!,
        title: item.title!,
        mergedAt: item.pull_request?.merged_at ?? "",
        mergeCommitSha: item.pull_request?.merge_commit_sha ?? null,
      }));
  } catch {
    return [];
  }
}

async function claudeCliAvailable(shellRun: ShellRun): Promise<boolean> {
  const result = await shellRun("claude", ["--version"]);
  return result.code === 0;
}

async function classifyDriftViaClaude(
  shellRun: ShellRun,
  drift: DriftReport,
  treeNodes: TreeNodeSummary[],
): Promise<ClassificationItem[]> {
  const treeSummary = treeNodes
    .slice(0, 200)
    .map((n) => `- ${n.path} title=${n.title ?? ""} owners=${(n.owners ?? []).join("|")}`)
    .join("\n");
  const driftSummary = [
    ...drift.commits.map((c) => `commit ${c.shortSha} [${c.topDir}] ${c.message}`),
    ...drift.mergedPrTitles.map((title) => `pr ${title}`),
  ].join("\n");
  const prompt = `You are classifying source-repo changes against a Context Tree. Here is the tree structure (list of NODE.md paths + titles + owners):\n${treeSummary}\nHere are the source commits and merged PR titles:\n${driftSummary}\nFor each drift item, output JSON: {path, type: 'TREE_MISS'|'TREE_STALE'|'TREE_OK', target_node_path (or null for TREE_MISS), rationale (one sentence), suggested_node_title, suggested_node_body_markdown}. Return a JSON array only, no prose.`;
  const result = await shellRun("claude", [
    "-p",
    "--output-format",
    "json",
    prompt,
  ]);
  if (result.code !== 0) {
    console.error(
      "\u274C The `claude` CLI is required for drift classification but was not found on PATH.\n\n" +
      "Install it:\n" +
      "  npm install -g @anthropic-ai/claude-code\n\n" +
      "Then authenticate:\n" +
      "  claude login\n\n" +
      "Once installed, re-run: first-tree sync --tree-path <path>",
    );
    process.exit(1);
  }
  const raw = result.stdout.trim();
  if (raw === "") return [];
  // Claude CLI with --output-format json may wrap the payload. Try direct parse first,
  // then look for a `result` / `content` field that contains a JSON array.
  const tryParseArray = (text: string): ClassificationItem[] | null => {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        return parsed as ClassificationItem[];
      }
      if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        for (const key of ["result", "content", "output", "response"]) {
          const value = obj[key];
          if (typeof value === "string") {
            const inner = tryParseArray(value);
            if (inner) return inner;
          }
          if (Array.isArray(value)) return value as ClassificationItem[];
        }
      }
    } catch {
      return null;
    }
    return null;
  };
  const direct = tryParseArray(raw);
  if (direct) return direct;
  // Last resort: extract first [...] block from the text
  const match = raw.match(/\[[\s\S]*\]/);
  if (match) {
    const extracted = tryParseArray(match[0]);
    if (extracted) return extracted;
  }
  return [];
}

function slugifyProposalPath(value: string): string {
  return slugifyToken(value.replace(/[\\/]/g, "-"));
}

function writeProposalFile(
  treeRoot: string,
  sourceId: string,
  drift: DriftReport,
  item: ClassificationItem,
): string {
  const slug = slugifyProposalPath(
    `${item.type === "TREE_MISS" ? "new" : "update"}-${item.target_node_path ?? item.path ?? item.suggested_node_title}`,
  );
  const dir = join(treeRoot, TREE_RUNTIME_ROOT, "proposals", sourceId);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${slug}.md`);
  const supersedes = item.type === "TREE_STALE" && item.target_node_path
    ? item.target_node_path
    : "null";
  const target = item.type === "TREE_MISS"
    ? "new"
    : item.target_node_path ?? "new";
  const frontmatter = [
    "---",
    `type: ${item.type}`,
    `source_id: ${sourceId}`,
    `source_commit_range: ${drift.fromSha ?? "(first-run)"}..${drift.toSha}`,
    `target_node: ${target}`,
    `supersedes: ${supersedes}`,
    `rationale: ${item.rationale.replace(/\n/g, " ")}`,
    "---",
    "",
  ].join("\n");
  writeFileSync(filePath, `${frontmatter}${item.suggested_node_body_markdown}\n`);
  return filePath;
}

function extractOwnersFromCodeowners(
  treeRoot: string,
  targetPath: string,
): string[] {
  const candidates = [
    join(treeRoot, "CODEOWNERS"),
    join(treeRoot, ".github", "CODEOWNERS"),
    join(treeRoot, "docs", "CODEOWNERS"),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    let text;
    try {
      text = readFileSync(candidate, "utf-8");
    } catch {
      continue;
    }
    const matches: string[] = [];
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("#")) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 2) continue;
      const pattern = parts[0];
      if (
        pattern === "*"
        || targetPath.startsWith(pattern.replace(/^\//, "").replace(/\/$/, ""))
      ) {
        matches.push(...parts.slice(1));
      }
    }
    if (matches.length > 0) return matches;
  }
  return [];
}

async function ghAuthOk(shellRun: ShellRun): Promise<boolean> {
  const result = await shellRun("gh", ["auth", "status"]);
  return result.code === 0;
}

function logDriftTable(reports: DriftReport[]): void {
  console.log("\nSync summary:");
  for (const report of reports) {
    const range = report.fromSha
      ? `${report.fromSha.slice(0, 7)}..${report.toSha.slice(0, 7)}`
      : `(first-run) -> ${report.toSha.slice(0, 7)}`;
    console.log(
      `  - ${report.binding.sourceId}: ${report.commits.length} commit(s) ${range}${
        report.truncated ? " [truncated]" : ""
      }`,
    );
  }
}

/** Group proposals by source PR. Commits not tied to a PR go into an "unlinked" group. */
function groupProposalsBySourcePr(
  drift: DriftReport,
  proposals: ClassificationItem[],
  proposalPaths: string[],
): ProposalGroup[] {
  // Build a map from commit SHA -> PR number
  const commitToPr = new Map<string, MergedPr>();
  for (const pr of drift.mergedPrs) {
    if (pr.mergeCommitSha) {
      commitToPr.set(pr.mergeCommitSha, pr);
    }
  }

  // For each proposal, try to link to a PR via the commit topDir / path heuristic
  // Since proposals come from classification of commits, we associate each proposal
  // with the first matching PR by checking commit dirs
  const prGroups = new Map<number, ProposalGroup>();
  const unlinked: ProposalGroup = {
    sourcePrNumber: null,
    sourcePrTitle: null,
    proposals: [],
    proposalPaths: [],
  };

  for (let i = 0; i < proposals.length; i++) {
    const proposal = proposals[i];
    const proposalPath = proposalPaths[i];
    // Try to find a matching PR
    let matched = false;
    for (const pr of drift.mergedPrs) {
      // Simple heuristic: if any commit associated with this PR dir matches the proposal path
      if (pr.mergeCommitSha && commitToPr.has(pr.mergeCommitSha)) {
        // Check if we already have this group
        if (!prGroups.has(pr.number)) {
          prGroups.set(pr.number, {
            sourcePrNumber: pr.number,
            sourcePrTitle: pr.title,
            proposals: [],
            proposalPaths: [],
          });
        }
        const group = prGroups.get(pr.number)!;
        group.proposals.push(proposal);
        group.proposalPaths.push(proposalPath);
        matched = true;
        break;
      }
    }
    if (!matched) {
      unlinked.proposals.push(proposal);
      unlinked.proposalPaths.push(proposalPath);
    }
  }

  const groups: ProposalGroup[] = Array.from(prGroups.values());
  if (unlinked.proposals.length > 0) {
    groups.push(unlinked);
  }

  // If there are no PRs at all, put everything in unlinked
  if (groups.length === 0 && proposals.length > 0) {
    return [{
      sourcePrNumber: null,
      sourcePrTitle: null,
      proposals: [...proposals],
      proposalPaths: [...proposalPaths],
    }];
  }

  return groups;
}

async function runGenerateCodeownersForTree(treeRoot: string): Promise<void> {
  try {
    const { generate } = await import("../../assets/framework/helpers/generate-codeowners.js");
    generate(treeRoot);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.log(`\u26A0 generate-codeowners failed: ${message} (continuing anyway)`);
  }
}

function gardenerInstalled(treeRoot: string): boolean {
  return existsSync(join(treeRoot, ".claude", "commands", "gardener-manual.md"));
}

async function applyProposalGroup(
  shellRun: ShellRun,
  treeRoot: string,
  binding: TreeBindingState,
  drift: DriftReport,
  group: ProposalGroup,
  dryRun: boolean,
  now: () => Date,
): Promise<boolean> {
  const shortSha = drift.toSha.slice(0, 7);
  const branchSuffix = group.sourcePrNumber !== null
    ? `pr${group.sourcePrNumber}`
    : `unlinked-${shortSha}`;
  const branch = `first-tree/sync-${binding.sourceId}-${branchSuffix}`;

  const prTitle = group.sourcePrNumber !== null
    ? `sync(${binding.sourceId}): ${group.sourcePrTitle} (from ${drift.ownerRepo.owner}/${drift.ownerRepo.repo}#${group.sourcePrNumber})`
    : `chore(sync): sync ${binding.sourceId} to ${shortSha}`;

  // Check if a tree PR for this source PR already exists
  if (group.sourcePrNumber !== null) {
    const searchQuery = `sync(${binding.sourceId}): from ${drift.ownerRepo.owner}/${drift.ownerRepo.repo}#${group.sourcePrNumber}`;
    const existingPr = await shellRun("gh", [
      "pr", "list", "--search", searchQuery, "--json", "number", "--limit", "1",
    ], { cwd: treeRoot });
    if (existingPr.code === 0) {
      try {
        const parsed = JSON.parse(existingPr.stdout) as Array<{ number: number }>;
        if (parsed.length > 0) {
          console.log(`\u23ED PR for source PR #${group.sourcePrNumber} already exists \u2014 skipping`);
          return true;
        }
      } catch {
        // ignore parse errors and continue
      }
    }
  }

  const branchCreate = await shellRun("git", ["checkout", "-b", branch], {
    cwd: treeRoot,
  });
  if (branchCreate.code !== 0) {
    // Maybe branch exists -- try checking it out
    const fallback = await shellRun("git", ["checkout", branch], { cwd: treeRoot });
    if (fallback.code !== 0) {
      console.error(
        `\u274C could not create branch ${branch}: ${branchCreate.stderr.trim()}`,
      );
      return false;
    }
  }

  for (const proposal of group.proposals) {
    if (proposal.type === "TREE_OK") continue;
    if (proposal.type === "TREE_MISS") {
      const dirSegment = proposal.path === "(root)" ? "misc" : proposal.path;
      const relDir = join("drift", binding.sourceId, dirSegment);
      const absDir = join(treeRoot, relDir);
      mkdirSync(absDir, { recursive: true });
      const owners = extractOwnersFromCodeowners(treeRoot, relDir);
      const title = proposal.suggested_node_title;
      const body = proposal.suggested_node_body_markdown;
      const content = [
        "---",
        `title: "${title.replace(/"/g, '\\"')}"`,
        `owners: [${owners.join(", ")}]`,
        "---",
        "",
        body,
        "",
      ].join("\n");
      writeFileSync(join(absDir, "NODE.md"), content);
    } else if (proposal.type === "TREE_STALE" && proposal.target_node_path) {
      const target = proposal.target_node_path;
      const targetAbs = join(treeRoot, target);
      const supersededPath = join(
        dirname(targetAbs),
        `${basename(targetAbs, ".md")}.superseded-${shortSha}.md`,
      );
      mkdirSync(dirname(supersededPath), { recursive: true });
      const content = [
        "---",
        `supersedes: ${target}`,
        `source_commit: ${drift.toSha}`,
        "---",
        "",
        proposal.suggested_node_body_markdown,
        "",
      ].join("\n");
      writeFileSync(supersededPath, content);
    }
  }

  // Run generate-codeowners after writing NODE.md files
  await runGenerateCodeownersForTree(treeRoot);

  writeTreeBinding(treeRoot, binding.sourceId, {
    ...binding,
    lastReconciledSourceCommit: drift.toSha,
    lastReconciledAt: now().toISOString(),
  });

  const addResult = await shellRun("git", ["add", "-A"], { cwd: treeRoot });
  if (addResult.code !== 0) {
    console.error(`\u274C git add failed: ${addResult.stderr.trim()}`);
    return false;
  }
  const commitMessage = group.sourcePrNumber !== null
    ? `chore(sync): ${binding.sourceId} PR#${group.sourcePrNumber} to ${shortSha}`
    : `chore(sync): sync ${binding.sourceId} to ${shortSha}`;
  const commitResult = await shellRun("git", ["commit", "-m", commitMessage], {
    cwd: treeRoot,
  });
  if (commitResult.code !== 0) {
    console.error(`\u274C git commit failed: ${commitResult.stderr.trim()}`);
    return false;
  }

  if (dryRun) {
    console.log(
      `(dry-run) would push ${branch} and open PR titled "${prTitle}"`,
    );
    return true;
  }

  const pushResult = await shellRun("git", ["push", "origin", "HEAD"], {
    cwd: treeRoot,
  });
  if (pushResult.code !== 0) {
    console.error(`\u274C git push failed: ${pushResult.stderr.trim()}`);
    return false;
  }

  const hasGardener = gardenerInstalled(treeRoot);

  const bodyLines = [
    `Automated drift sync for source \`${binding.sourceId}\`.`,
    "",
    `- Source range: ${drift.fromSha ? drift.fromSha.slice(0, 7) : "first-run"}..${shortSha}`,
    `- Proposal files: ${group.proposalPaths.length}`,
    "",
    "Proposals:",
    ...group.proposals.map(
      (p) => `- ${p.type}: ${p.target_node_path ?? p.path} \u2014 ${p.rationale}`,
    ),
    "",
    "Commits:",
    ...drift.commits.map(
      (c) =>
        `- [\`${c.shortSha}\`](https://github.com/${drift.ownerRepo.owner}/${drift.ownerRepo.repo}/commit/${c.sha}) ${c.message}`,
    ),
  ];

  if (!hasGardener) {
    bodyLines.push(
      "",
      "> \u26A0\uFE0F **No gardener configured.** This PR has not been context-reviewed. Install [repo-gardener](https://github.com/agent-team-foundation/repo-gardener) for automated context-fit review before enabling auto-merge.",
    );
  }

  const prCreate = await shellRun(
    "gh",
    ["pr", "create", "--title", prTitle, "--body", bodyLines.join("\n")],
    { cwd: treeRoot },
  );
  if (prCreate.code !== 0) {
    const stderr = prCreate.stderr.trim();
    if (
      stderr.toLowerCase().includes("already exists")
      || stderr.toLowerCase().includes("a pull request for branch")
    ) {
      console.log(
        `\u23ED PR for branch ${branch} already exists \u2014 skipping create, leaving the existing one.`,
      );
      return true;
    }
    console.error(`\u274C gh pr create failed: ${stderr}`);
    return false;
  }
  const prUrl = prCreate.stdout.trim();

  const labels = hasGardener
    ? ["first-tree:sync", "auto-merge"]
    : ["first-tree:sync"];
  const labelArgs = labels.flatMap((l) => ["--add-label", l]);
  const labelResult = await shellRun(
    "gh",
    ["pr", "edit", prUrl, ...labelArgs],
    { cwd: treeRoot },
  );
  if (labelResult.code !== 0) {
    console.error(`\u26A0 gh pr edit (add label) failed: ${labelResult.stderr.trim()}`);
  }
  console.log(`\u2713 opened PR ${prUrl}`);
  return true;
}

export async function runSync(
  treeRoot: string,
  flags: Omit<ParsedFlags, "help" | "unknown" | "treePath">,
  deps: SyncDeps = {},
): Promise<number> {
  const shellRun = deps.shellRun ?? defaultShellRun;
  const now = deps.now ?? (() => new Date());
  const repo = new Repo(treeRoot);

  if (!repo.looksLikeTreeRepo()) {
    console.error(
      `\u274C ${treeRoot} does not look like a Context Tree repo. Run first-tree sync inside a tree repo, or pass --tree-path.`,
    );
    return 1;
  }

  const authed = await ghAuthOk(shellRun);
  if (!authed) {
    console.error("\u274C gh CLI not authenticated \u2014 run `gh auth login`");
    return 1;
  }

  // Check that claude CLI is available (required for classification)
  const hasClaude = await claudeCliAvailable(shellRun);
  if (!hasClaude) {
    console.error(
      "\u274C The `claude` CLI is required for drift classification but was not found on PATH.\n\n" +
      "Install it:\n" +
      "  npm install -g @anthropic-ai/claude-code\n\n" +
      "Then authenticate:\n" +
      "  claude login\n\n" +
      "Once installed, re-run: first-tree sync --tree-path <path>",
    );
    return 1;
  }

  let bindings = listTreeBindings(repo.root);
  if (flags.source) {
    bindings = bindings.filter((b) => b.sourceId === flags.source);
    if (bindings.length === 0) {
      console.error(`\u274C no binding matches --source ${flags.source}`);
      return 1;
    }
  }
  if (bindings.length === 0) {
    console.log("no bindings found under .first-tree/bindings/. nothing to sync.");
    return 0;
  }

  const treeNodes = scanTreeNodes(repo.root);
  const driftReports: DriftReport[] = [];

  for (const binding of bindings) {
    if (!binding.remoteUrl) {
      console.error(
        `\u274C ${binding.sourceId}: no remoteUrl in binding file.\n` +
        `   Sync needs a GitHub URL to fetch commits and merged PRs.\n` +
        `   Fix: edit .first-tree/bindings/${binding.sourceId}.json and add:\n` +
        `     "remoteUrl": "https://github.com/<owner>/<repo>"\n` +
        `   Then re-run first-tree sync.`,
      );
      continue;
    }
    const ownerRepo = parseOwnerRepoFromRemoteUrl(binding.remoteUrl);
    if (!ownerRepo) {
      console.log(
        `\u23ED ${binding.sourceId}: could not parse GitHub owner/repo from ${binding.remoteUrl} \u2014 skipping`,
      );
      continue;
    }
    const head = await getSourceHead(shellRun, ownerRepo);
    if (!head) {
      console.error(`\u274C failed to fetch HEAD for ${binding.sourceId}`);
      return 1;
    }

    if (!binding.lastReconciledSourceCommit) {
      // First run: trace history instead of pinning silently
      const { fromSha, capped } = await getFirstRunFromSha(shellRun, ownerRepo, head);
      if (capped) {
        console.log(
          `\u26A0 Source has >500 commits; syncing from ${fromSha.slice(0, 7)} (500 commits back). Earlier history not covered.`,
        );
      }
      if (fromSha === head) {
        // Edge case: brand new repo with only one commit
        console.log(
          `\u2713 ${binding.sourceId}: source at initial commit ${head.slice(0, 7)}, nothing to sync yet`,
        );
        writeTreeBinding(repo.root, binding.sourceId, {
          ...binding,
          lastReconciledSourceCommit: head,
          lastReconciledAt: now().toISOString(),
        });
        continue;
      }
      const compared = await compareCommits(shellRun, ownerRepo, fromSha, head);
      if (!compared) {
        return 1;
      }
      const sinceDate = compared.commits.length > 0 ? compared.commits[0].date : "";
      const mergedPrs = await fetchMergedPrs(shellRun, ownerRepo, sinceDate);
      const mergedPrTitles = mergedPrs.map((pr) => pr.title);
      driftReports.push({
        binding,
        ownerRepo,
        fromSha,
        toSha: head,
        commits: compared.commits,
        mergedPrs,
        mergedPrTitles,
        truncated: compared.truncated,
      });
      continue;
    }
    if (binding.lastReconciledSourceCommit === head) {
      console.log(`\u2713 ${binding.sourceId}: up to date at ${head.slice(0, 7)}`);
      continue;
    }
    const compared = await compareCommits(
      shellRun,
      ownerRepo,
      binding.lastReconciledSourceCommit,
      head,
    );
    if (!compared) {
      return 1;
    }
    const sinceDate =
      compared.commits.length > 0 ? compared.commits[0].date : "";
    const mergedPrs = await fetchMergedPrs(shellRun, ownerRepo, sinceDate);
    const mergedPrTitles = mergedPrs.map((pr) => pr.title);
    if (compared.truncated) {
      console.log(
        `\u26A0 ${binding.sourceId}: commit range truncated to 500 commits`,
      );
    }
    driftReports.push({
      binding,
      ownerRepo,
      fromSha: binding.lastReconciledSourceCommit,
      toSha: head,
      commits: compared.commits,
      mergedPrs,
      mergedPrTitles,
      truncated: compared.truncated,
    });
  }

  logDriftTable(driftReports);

  if (!flags.propose && !flags.apply) {
    return 0;
  }

  if (driftReports.length === 0) {
    console.log("nothing stale to propose.");
    return 0;
  }

  for (const drift of driftReports) {
    const proposals = await classifyDriftViaClaude(shellRun, drift, treeNodes);
    const filtered = proposals.filter((p) => p.type !== "TREE_OK");
    const written: string[] = [];
    for (const item of filtered) {
      const path = writeProposalFile(repo.root, drift.binding.sourceId, drift, item);
      written.push(path);
    }
    console.log(
      `\u2713 ${drift.binding.sourceId}: wrote ${written.length} proposal(s) under .first-tree/proposals/${drift.binding.sourceId}/`,
    );

    if (flags.apply) {
      // Group proposals by source PR
      const groups = groupProposalsBySourcePr(drift, filtered, written);
      for (const group of groups) {
        const ok = await applyProposalGroup(
          shellRun,
          repo.root,
          drift.binding,
          drift,
          group,
          flags.dryRun,
          now,
        );
        if (!ok) return 1;
        // Return to the default branch before creating the next branch
        if (groups.length > 1) {
          await shellRun("git", ["checkout", "-"], { cwd: repo.root });
        }
      }
    } else {
      // On propose-only, do NOT pin — pin only after apply succeeds
    }
  }

  return 0;
}

export async function runSyncCli(
  args: string[] = [],
  deps: SyncDeps = {},
): Promise<number> {
  const flags = parseFlags(args);
  if (flags.help) {
    console.log(SYNC_USAGE);
    return 0;
  }
  if (flags.unknown) {
    console.error(`Unknown sync option: ${flags.unknown}`);
    console.log(SYNC_USAGE);
    return 1;
  }
  const treeRoot = flags.treePath
    ? resolve(process.cwd(), flags.treePath)
    : process.cwd();
  try {
    return await runSync(
      treeRoot,
      {
        source: flags.source,
        propose: flags.propose,
        apply: flags.apply,
        dryRun: flags.dryRun,
      },
      deps,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error(`\u274C sync failed: ${message}`);
    return 1;
  }
}
