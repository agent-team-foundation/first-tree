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
import { Repo } from "#products/tree/engine/repo.js";
import { runVerify } from "#products/tree/engine/verify.js";
import {
  TREE_RUNTIME_ROOT,
} from "#products/tree/engine/runtime/asset-loader.js";
import {
  listTreeBindings,
  slugifyToken,
  writeTreeBinding,
  type TreeBindingState,
} from "#products/tree/engine/runtime/binding-state.js";
import { resolveNodeOwners } from "../../../../assets/tree/helpers/generate-codeowners.js";
import { openTreePr } from "#products/tree/engine/open-tree-pr.js";
import type {
  ShellResult,
  ShellRun,
} from "#products/tree/engine/runtime/shell.js";

const execFileAsync = promisify(execFile);

export const SYNC_USAGE = `usage: first-tree tree sync [--tree-path PATH] [--source ID] [--propose] [--apply] [--dry-run]

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


export interface SyncDeps {
  shellRun?: ShellRun;
  now?: () => Date;
  verifyTree?: (treeRoot: string) => number | Promise<number>;
}

async function defaultShellRun(
  command: string,
  args: string[],
  options: { cwd?: string; input?: string; timeout?: number } = {},
): Promise<ShellResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      encoding: "utf-8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: options.timeout,
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
  body: string | undefined;
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
const GITHUB_RE = /^github:\s*['"]?(.+?)['"]?\s*$/m;
const LEADING_FRONTMATTER_RE = /^---\s*\r?\n[\s\S]*?\r?\n---(?:\s*\r?\n)?/;

function parseNodeFrontmatter(text: string): {
  title: string | undefined;
  owners: string[] | undefined;
  github: string | undefined;
} {
  const match = text.match(FRONTMATTER_RE);
  if (!match) return { title: undefined, owners: undefined, github: undefined };
  const fm = match[1];
  const titleMatch = fm.match(TITLE_RE);
  const ownersMatch = fm.match(OWNERS_RE);
  const githubMatch = fm.match(GITHUB_RE);
  const title = titleMatch ? titleMatch[1].trim() : undefined;
  let owners: string[] | undefined;
  if (ownersMatch) {
    const raw = ownersMatch[1].trim();
    owners = raw === ""
      ? []
      : raw.split(",").map((o) => o.trim()).filter(Boolean);
  }
  const github = githubMatch ? githubMatch[1].trim() : undefined;
  return { title, owners, github };
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
          // Extract body (everything after frontmatter)
          const bodyMatch = text.match(/^---\s*\n.*?\n---\s*\n?([\s\S]*)/s);
          const body = bodyMatch ? bodyMatch[1].trim() : undefined;
          results.push({
            path: relative(root, full).split("\\").join("/"),
            title,
            owners,
            body: body && body.length > 0 ? body : undefined,
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

function normalizeGitHubLogin(value: string): string {
  return value.trim().replace(/^@+/, "").toLowerCase();
}

function sanitizeSuggestedNodeBodyMarkdown(markdown: string): string {
  const trimmed = markdown.trim();
  if (trimmed === "") return trimmed;
  const withoutFrontmatter = trimmed.replace(LEADING_FRONTMATTER_RE, "").trim();
  return withoutFrontmatter === "" ? trimmed : withoutFrontmatter;
}

function findExistingMemberDirByAuthorLogin(
  treeRoot: string,
  authorLogin: string | null,
): string | null {
  if (!authorLogin) return null;
  const normalizedAuthor = normalizeGitHubLogin(authorLogin);
  if (normalizedAuthor === "") return null;
  const membersRoot = join(treeRoot, "members");
  if (!existsSync(membersRoot)) return null;

  const matches: string[] = [];
  const walk = (dir: string): void => {
    const nodePath = join(dir, "NODE.md");
    if (existsSync(nodePath)) {
      try {
        const text = readFileSync(nodePath, "utf-8");
        const { owners, github } = parseNodeFrontmatter(text);
        const matchesAuthor =
          (owners ?? []).some((owner) => normalizeGitHubLogin(owner) === normalizedAuthor)
          || (github ? normalizeGitHubLogin(github) === normalizedAuthor : false);
        if (matchesAuthor) {
          matches.push(relative(treeRoot, dir).split("\\").join("/"));
        }
      } catch {
        // ignore unreadable member nodes
      }
    }

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const child = join(dir, entry);
      try {
        if (!statSync(child).isDirectory()) continue;
      } catch {
        continue;
      }
      walk(child);
    }
  };

  walk(membersRoot);
  matches.sort((a, b) => {
    const depthDiff = a.split("/").length - b.split("/").length;
    return depthDiff !== 0 ? depthDiff : a.localeCompare(b);
  });
  return matches[0] ?? null;
}

function resolveProposalOwners(
  treeRoot: string,
  targetDir: string,
  authorLogin: string | null,
): string[] {
  const combined = [...resolveNodeOwners(targetDir, treeRoot, new Map())];
  if (authorLogin) {
    combined.push(authorLogin);
  }

  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const owner of combined) {
    const cleaned = owner.replace(/^@+/, "").trim();
    if (cleaned === "") continue;
    const normalized = normalizeGitHubLogin(cleaned);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    resolved.push(cleaned);
  }
  return resolved;
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
  authorLogin: string | null;
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
  type: "TREE_MISS" | "TREE_OK";
  rationale: string;
  suggested_node_title: string;
  suggested_node_body_markdown: string;
  /**
   * Tree paths (e.g. "engineering/backend", "governance") that the drafted
   * NODE.md body references and should be declared as frontmatter
   * `soft_links` (#124). Optional — omit or empty when there are no
   * cross-domain references.
   */
  suggested_soft_links?: string[];
  /**
   * Source PR numbers (other than the owning group's) that independently
   * proposed this same target path. Populated by the dedup pass so the
   * surviving PR can credit the dropped claimants in its body (#121).
   */
  coClaimingSourcePrs?: number[];
}

/** A group of proposals tied to one source PR (or unlinked commits). */
interface ProposalGroup {
  sourcePrNumber: number | null;
  sourcePrTitle: string | null;
  sourcePrAuthorLogin: string | null;
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
        user?: { login?: string };
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
        authorLogin: item.user?.login?.trim() ?? null,
      }));
  } catch {
    return [];
  }
}

async function claudeCliAvailable(shellRun: ShellRun): Promise<boolean> {
  const result = await shellRun("claude", ["--version"]);
  return result.code === 0;
}

interface PrFileChange {
  filename: string;
  patch: string | undefined;
  status: string | undefined;
}

const DIFF_NOISE_PATTERNS = [
  /(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|Gemfile\.lock)$/,
  /(^|\/)(?:dist|build|out|coverage|node_modules|__pycache__)\//,
  /\.(?:lock|min\.js|min\.css|map|snap)$/,
];

function isDiffNoise(filename: string): boolean {
  return DIFF_NOISE_PATTERNS.some((re) => re.test(filename));
}

async function fetchPrFileChanges(
  shellRun: ShellRun,
  ownerRepo: { owner: string; repo: string },
  prNumber: number,
): Promise<PrFileChange[]> {
  try {
    const result = await shellRun("gh", [
      "api", `/repos/${ownerRepo.owner}/${ownerRepo.repo}/pulls/${prNumber}/files`,
      "--paginate",
    ]);
    if (result.code !== 0) return [];
    const raw = result.stdout.trim();
    if (raw === "") return [];
    // --paginate concatenates JSON arrays; normalize to a flat array.
    const normalized = raw.replace(/\]\s*\[/g, ",");
    const parsed = JSON.parse(normalized) as Array<{ filename?: string; patch?: string; status?: string }>;
    return parsed
      .filter((f) => typeof f.filename === "string")
      .map((f) => ({ filename: f.filename!, patch: f.patch, status: f.status }));
  } catch {
    return [];
  }
}

/**
 * Build a truncated diff summary for the classification prompt (#123).
 * Filters generated/lockfile noise and caps per-file hunks so large PRs
 * don't blow the context window.
 */
function formatPrDiffForPrompt(
  files: PrFileChange[],
  opts?: { maxFiles?: number; maxLinesPerFile?: number },
): string {
  const maxFiles = opts?.maxFiles ?? 15;
  const maxLinesPerFile = opts?.maxLinesPerFile ?? 40;
  const signal = files.filter((f) => !isDiffNoise(f.filename));
  const selected = signal.slice(0, maxFiles);
  const parts: string[] = [];
  for (const f of selected) {
    if (!f.patch) continue;
    const lines = f.patch.split("\n");
    const truncated = lines.length > maxLinesPerFile;
    const shown = truncated ? lines.slice(0, maxLinesPerFile) : lines;
    parts.push(`--- ${f.filename} (${f.status ?? "modified"})`);
    parts.push(...shown);
    if (truncated) {
      parts.push(`... (${lines.length - maxLinesPerFile} more lines in this file)`);
    }
  }
  if (signal.length > maxFiles) {
    parts.push(`... (${signal.length - maxFiles} more files omitted)`);
  }
  return parts.join("\n");
}

async function classifyDriftViaClaude(
  shellRun: ShellRun,
  drift: DriftReport,
  treeNodes: TreeNodeSummary[],
  changedFiles?: string[],
  diffSummary?: string,
): Promise<ClassificationItem[]> {
  // Build keywords from the PR for relevance matching
  const driftText = [
    ...drift.commits.map((c) => c.message),
    ...drift.mergedPrTitles,
  ].join(" ").toLowerCase();

  // Find related nodes by keyword overlap (path segments, title words)
  const relatedNodes = treeNodes.filter((n) => {
    const nodeText = [
      n.path.replace(/\//g, " ").replace(/NODE\.md/g, ""),
      n.title ?? "",
    ].join(" ").toLowerCase();
    const nodeWords = nodeText.split(/\s+/).filter((w) => w.length > 2);
    return nodeWords.some((word) => driftText.includes(word));
  });

  // Build tree summary: all nodes get path+title, related nodes also get body
  const treeLines: string[] = [];
  for (const n of treeNodes.slice(0, 200)) {
    const isRelated = relatedNodes.includes(n);
    const line = `- ${n.path} title="${n.title ?? ""}" owners=${(n.owners ?? []).join("|")}`;
    if (isRelated && n.body) {
      // Include body for related nodes (cap at 500 chars to keep prompt reasonable)
      const bodyPreview = n.body.length > 500 ? n.body.slice(0, 500) + "..." : n.body;
      treeLines.push(`${line}\n  CONTENT: ${bodyPreview.replace(/\n/g, " ")}`);
    } else {
      treeLines.push(line);
    }
  }
  const treeSummary = treeLines.join("\n");

  const driftSummary = [
    ...drift.commits.map((c) => `commit ${c.shortSha} [${c.topDir}] ${c.message}`),
    ...drift.mergedPrTitles.map((title) => `pr ${title}`),
    ...(changedFiles && changedFiles.length > 0
      ? [`\nChanged files in this PR (use these to verify what was actually modified):\n${changedFiles.slice(0, 50).join("\n")}`]
      : []),
    ...(diffSummary && diffSummary.length > 0
      ? [`\nTruncated diff hunks (use these as factual ground truth; generated/lockfile noise is filtered):\n${diffSummary}`]
      : []),
  ].join("\n");

  const relatedCount = relatedNodes.length;
  const prompt = `You are a Context Tree maintenance agent. A Context Tree is a structured knowledge base (markdown NODE.md files) that captures product decisions, architecture, conventions, and domain knowledge for a codebase.

Your job: given the tree's current nodes and a recently merged PR, determine whether the tree is MISSING knowledge that this PR introduced.

Context: this PR has already been reviewed and approved (including context-fit review by gardener). It does not conflict with the tree. The only question is: did it introduce NEW knowledge that the tree doesn't yet capture?

IMPORTANT:
- For nodes marked with CONTENT below, read the content carefully. A node might exist for an area but NOT cover the specific feature this PR added.
- If "Changed files" are listed below, use them to verify what the PR actually modified. Do NOT describe features not reflected in the changed file paths.
- Be factually precise: only describe capabilities the source PR actually introduced. Do not extrapolate or generalize beyond what the diff shows.
- For example, if an "Authentication" node only mentions JWT but the PR adds OAuth support, that is a TREE_MISS — the tree needs a new node (or the existing node needs supplementing, which counts as TREE_MISS for sync purposes).

Ask yourself:
- Did this PR add a new feature, module, convention, or architectural pattern that NO existing node covers in its content? → TREE_MISS
- Do the existing nodes (including their content) already adequately describe what this PR introduced? → TREE_OK

Bias toward TREE_MISS. If in doubt, classify as TREE_MISS.

## Current tree nodes (${treeNodes.length} total, ${relatedCount} with content shown)
${treeSummary}

## Merged PR
${driftSummary}

## Output format
Return a JSON array. Each element represents one area that needs a NEW tree node (NOT one per commit — group related changes):
{
  "path": "suggested/node/path",
  "type": "TREE_MISS" | "TREE_OK",
  "rationale": "one sentence explaining why the tree needs this node",
  "suggested_node_title": "Human-readable title for the node",
  "suggested_node_body_markdown": "Draft NODE.md body content ONLY (2-5 paragraphs, no YAML frontmatter)",
  "suggested_soft_links": ["other/tree/path", "another/one"]
}

For TREE_OK items, only path, type, and rationale are required (other fields can be empty strings or omitted).

IMPORTANT:
- Only return TREE_MISS or TREE_OK. Sync does not support in-place edits to existing NODE.md files, so do not propose supplement-style updates — if an existing node needs more content, classify as TREE_MISS with a new path and leave the existing node alone.
- \`suggested_node_body_markdown\` must contain body content only. Do NOT include YAML frontmatter or code fences.
- \`suggested_soft_links\` must list every tree path the body cross-references (other domains, governance, backend, etc.) so the new node shows up in the tree graph. Use paths from the "Current tree nodes" list above. Omit or use [] when the body does not reference other domains.

Return a JSON array only, no prose.`;
  const CLAUDE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per classification
  const MAX_RETRIES = 2;
  let result: ShellResult | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    result = await shellRun("claude", [
      "-p",
      "--output-format",
      "json",
      prompt,
    ], { timeout: CLAUDE_TIMEOUT_MS });
    if (result.code === 0) break;
    const isRateLimit = result.stderr.includes("429") || result.stderr.includes("rate") || result.stderr.includes("Too Many");
    const timedOut = result.stderr.includes("ETIMEDOUT") || result.stderr.includes("killed");
    if (timedOut) {
      console.error(`\u26A0 Claude CLI timed out after 5 minutes. Skipping this PR.`);
      return [];
    }
    if (isRateLimit && attempt < MAX_RETRIES) {
      const waitSec = (attempt + 1) * 15;
      console.log(`  \u26A0 Rate limited (429). Retrying in ${waitSec}s... (attempt ${attempt + 2}/${MAX_RETRIES + 1})`);
      await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
      continue;
    }
    break;
  }
  if (!result || result.code !== 0) {
    console.error(
      "\u274C The `claude` CLI is required for drift classification but was not found on PATH.\n\n" +
      "Install it:\n" +
      "  npm install -g @anthropic-ai/claude-code\n\n" +
      "Then authenticate:\n" +
      "  claude login\n\n" +
      "Once installed, re-run: first-tree tree sync --tree-path <path>",
    );
    process.exit(1);
  }
  const raw = result.stdout.trim();
  if (process.env.FIRST_TREE_DEBUG) {
    console.error(`[DEBUG] claude exit code: ${result.code}`);
    console.error(`[DEBUG] claude stdout (first 2000 chars): ${raw.slice(0, 2000)}`);
    console.error(`[DEBUG] claude stderr (first 500 chars): ${(result.stderr ?? "").slice(0, 500)}`);
  }
  if (raw === "") return [];
  // Claude CLI with --output-format json may wrap the payload. Try direct parse first,
  // then look for a `result` / `content` field that contains a JSON array.
  const extractJsonArray = (text: string): string | null => {
    // Try extracting from ```json ... ``` fences (may appear anywhere in text)
    const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenced) return fenced[1].trim();
    // Try extracting a bare [...] block
    const bare = text.match(/\[[\s\S]*\]/);
    if (bare) return bare[0];
    return null;
  };
  const tryParseArray = (text: string): ClassificationItem[] | null => {
    // First try direct JSON.parse
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
            // Try extracting JSON array from the string value (may have prose + code fences)
            const extracted = extractJsonArray(value);
            if (extracted) {
              const inner = tryParseArray(extracted);
              if (inner) return inner;
            }
          }
          if (Array.isArray(value)) return value as ClassificationItem[];
        }
      }
    } catch {
      // Not valid JSON — try extracting array from raw text
      const extracted = extractJsonArray(text);
      if (extracted && extracted !== text) {
        try {
          const parsed = JSON.parse(extracted) as unknown;
          if (Array.isArray(parsed)) return parsed as ClassificationItem[];
        } catch { /* fall through */ }
      }
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
    `new-${item.path ?? item.suggested_node_title}`,
  );
  const dir = join(treeRoot, TREE_RUNTIME_ROOT, "proposals", sourceId);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${slug}.md`);
  const body = sanitizeSuggestedNodeBodyMarkdown(item.suggested_node_body_markdown);
  const frontmatter = [
    "---",
    `type: ${item.type}`,
    `source_id: ${sourceId}`,
    `source_commit_range: ${drift.fromSha ?? "(first-run)"}..${drift.toSha}`,
    `target_node: new`,
    `rationale: ${item.rationale.replace(/\n/g, " ")}`,
    "---",
    "",
  ].join("\n");
  writeFileSync(filePath, `${frontmatter}${body}\n`);
  return filePath;
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

async function runGenerateCodeownersForTree(treeRoot: string): Promise<void> {
  try {
    const { generate } = await import("../../../../assets/tree/helpers/generate-codeowners.js");
    generate(treeRoot);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.log(`\u26A0 generate-codeowners failed: ${message} (continuing anyway)`);
  }
}

async function resolveStableCheckoutRef(
  shellRun: ShellRun,
  treeRoot: string,
): Promise<string | null> {
  const branchResult = await shellRun("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd: treeRoot,
  });
  const branchName = branchResult.stdout.trim();
  if (branchResult.code === 0 && branchName !== "") {
    return branchName;
  }

  const headResult = await shellRun("git", ["rev-parse", "HEAD"], {
    cwd: treeRoot,
  });
  const headSha = headResult.stdout.trim();
  if (headResult.code === 0 && headSha !== "") {
    return headSha;
  }

  console.error(
    "\u274C could not determine the original git checkout for sync apply.",
  );
  return null;
}

/** Result of preparing a proposal group (branch created, files committed locally). */
interface PreparedProposalGroup {
  branch: string;
  prTitle: string;
  prBody: string;
  group: ProposalGroup;
  skipped: boolean;
  skipReason?: string;
}

/**
 * Phase 1: Prepare a proposal group by creating a branch and committing locally.
 * This must be done sequentially because git checkout requires exclusive access.
 * Returns the branch name and PR metadata for the push/create phase.
 */
interface ParentSubDomainAddition {
  dirName: string;
  title: string;
}

async function prepareProposalGroup(
  shellRun: ShellRun,
  treeRoot: string,
  binding: TreeBindingState,
  drift: DriftReport,
  group: ProposalGroup,
  baseRef: string,
  verifyTree: (treeRoot: string) => number | Promise<number>,
  pendingParentAdditions: Map<string, ParentSubDomainAddition[]>,
): Promise<PreparedProposalGroup | null> {
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
          return {
            branch,
            prTitle,
            prBody: "",
            group,
            skipped: true,
            skipReason: `PR for source PR #${group.sourcePrNumber} already exists`,
          };
        }
      } catch {
        // ignore parse errors and continue
      }
    }
  }

  const branchCreate = await shellRun("git", ["checkout", "-B", branch, baseRef], {
    cwd: treeRoot,
  });
  if (branchCreate.code !== 0) {
    console.error(
      `\u274C could not create branch ${branch}: ${branchCreate.stderr.trim()}`,
    );
    return null;
  }

  // Write nodes directly to real tree paths (not drift/)
  const writtenFiles: string[] = [];
  for (const proposal of group.proposals) {
    if (proposal.type === "TREE_OK") continue;
    if (proposal.type === "TREE_MISS") {
      let dirSegment = proposal.path === "(root)" ? "misc" : proposal.path;
      // Strip trailing /NODE.md if the AI included it in the path
      dirSegment = dirSegment.replace(/\/NODE\.md$/i, "").replace(/^NODE\.md$/i, "misc");
      if (dirSegment.startsWith("members/")) {
        const existingMemberDir = findExistingMemberDirByAuthorLogin(
          treeRoot,
          group.sourcePrAuthorLogin,
        );
        if (existingMemberDir) {
          dirSegment = existingMemberDir;
        }
      }
      const absDir = join(treeRoot, dirSegment);
      mkdirSync(absDir, { recursive: true });
      const owners = resolveProposalOwners(
        treeRoot,
        absDir,
        group.sourcePrAuthorLogin,
      );
      const title = proposal.suggested_node_title;
      const capitalizedTitle = title.charAt(0).toUpperCase() + title.slice(1);
      const body = sanitizeSuggestedNodeBodyMarkdown(
        proposal.suggested_node_body_markdown,
      );
      const nodePath = join(absDir, "NODE.md");
      // Only write if NODE.md doesn't already exist (don't overwrite human-authored nodes)
      if (!existsSync(nodePath)) {
        const frontmatter = [
          "---",
          `title: "${capitalizedTitle.replace(/"/g, '\\"')}"`,
          `owners: [${owners.join(", ")}]`,
        ];
        const softLinks = Array.isArray(proposal.suggested_soft_links)
          ? Array.from(
              new Set(
                proposal.suggested_soft_links
                  .map((s) => (typeof s === "string" ? s.trim() : ""))
                  .filter((s) => s.length > 0 && s !== dirSegment),
              ),
            ).sort()
          : [];
        if (softLinks.length > 0) {
          frontmatter.push(`soft_links: [${softLinks.join(", ")}]`);
        }
        frontmatter.push("---");
        const content = [
          ...frontmatter,
          "",
          body,
          "",
        ].join("\n");
        writeFileSync(nodePath, content);
        writtenFiles.push(nodePath);

        // Queue the parent NODE.md `## Sub-domains` update for the
        // housekeeping branch (#188). Per-content branches all fork from
        // the same baseRef, so writing the parent here would make each
        // branch's edit conflict with siblings at merge time. The
        // housekeeping branch runs last and can batch every sibling's
        // rollup in one idempotent pass.
        const parentNodePath = join(dirname(absDir), "NODE.md");
        if (existsSync(parentNodePath)) {
          const newDirName = basename(absDir);
          const list = pendingParentAdditions.get(parentNodePath) ?? [];
          if (!list.some((a) => a.dirName === newDirName)) {
            list.push({ dirName: newDirName, title: capitalizedTitle });
          }
          pendingParentAdditions.set(parentNodePath, list);
        }
      }
    }
  }

  if (writtenFiles.length === 0) {
    return {
      branch,
      prTitle,
      prBody: "",
      group,
      skipped: true,
      skipReason: "No new files to commit",
    };
  }

  // Regenerate CODEOWNERS alongside the new NODE.md files so each content PR
  // is self-consistent under `generate-codeowners --check`. Without this the
  // check fails per-PR until the housekeeping PR catches up (#119).
  await runGenerateCodeownersForTree(treeRoot);
  const codeownersPath = join(treeRoot, ".github", "CODEOWNERS");
  if (existsSync(codeownersPath)) {
    writtenFiles.push(codeownersPath);
  }

  // NOTE: Only stage the specific files this PR produced (new NODE.md files,
  // any parent NODE.md updates, and the regenerated CODEOWNERS). Do NOT use
  // `git add -A` — that would pick up proposal files and the binding from
  // other in-flight work and create a mega-PR.
  for (const file of writtenFiles) {
    await shellRun("git", ["add", file], { cwd: treeRoot });
  }
  // Check if there's anything staged (diff --cached --quiet exits 0 = nothing, 1 = has changes)
  const stagingCheck = await shellRun("git", ["diff", "--cached", "--quiet"], { cwd: treeRoot });
  if (stagingCheck.code === 0) {
    // Nothing staged — files already existed or were already committed
    return {
      branch,
      prTitle,
      prBody: "",
      group,
      skipped: true,
      skipReason: "Nothing new to commit",
    };
  }
  const commitMessage = group.sourcePrNumber !== null
    ? `chore(sync): ${binding.sourceId} PR#${group.sourcePrNumber} to ${shortSha}`
    : `chore(sync): sync ${binding.sourceId} to ${shortSha}`;
  const commitResult = await shellRun("git", ["commit", "-m", commitMessage], {
    cwd: treeRoot,
  });
  if (commitResult.code !== 0) {
    console.error(`\u274C git commit failed: ${commitResult.stderr.trim()}`);
    return null;
  }

  const verifyCode = await verifyTree(treeRoot);
  if (verifyCode !== 0) {
    return {
      branch,
      prTitle,
      prBody: "",
      group,
      skipped: true,
      skipReason: "first-tree tree verify failed",
    };
  }

  const bodyLines = [
    `Automated drift sync for source \`${binding.sourceId}\`.`,
    "",
    `- Source range: ${drift.fromSha ? drift.fromSha.slice(0, 7) : "first-run"}..${shortSha}`,
    `- Proposal files: ${group.proposalPaths.length}`,
    "",
    "Proposals:",
    ...group.proposals.map((p) => {
      const base = `- ${p.type}: ${p.path} \u2014 ${p.rationale}`;
      if (p.coClaimingSourcePrs && p.coClaimingSourcePrs.length > 0) {
        const credits = p.coClaimingSourcePrs.map((n) => `#${n}`).join(", ");
        return `${base} (also identified by ${credits})`;
      }
      return base;
    }),
    "",
    "Commits:",
    ...drift.commits.map(
      (c) =>
        `- [\`${c.shortSha}\`](https://github.com/${drift.ownerRepo.owner}/${drift.ownerRepo.repo}/commit/${c.sha}) ${c.message}`,
    ),
    "",
    "---",
    "",
    "\uD83D\uDCAC **Reviewer:** comment `@gardener fix` after leaving feedback.",
    "gardener will read your review, push a fix, and reply.",
    "(Or just leave a review \u2014 gardener auto-checks every 30 minutes.)",
  ];

  return {
    branch,
    prTitle,
    prBody: bodyLines.join("\n"),
    group,
    skipped: false,
  };
}

/**
 * Phase 2: Push branches and create PRs.
 * This can be parallelized because each branch is independent.
 *
 * Thin adapter over `openTreePr` that maps sync's `PreparedProposalGroup`
 * to the primitive's option shape and applies the sync-specific label set.
 */
async function pushAndCreatePr(
  shellRun: ShellRun,
  treeRoot: string,
  prepared: PreparedProposalGroup,
): Promise<{ success: boolean; prUrl?: string; error?: string }> {
  return openTreePr(shellRun, treeRoot, {
    branch: prepared.branch,
    title: prepared.prTitle,
    body: prepared.prBody,
    labels: ["first-tree:sync"],
  });
}

/**
 * Run push and PR creation in parallel with concurrency limit and rate-limit backoff.
 */
async function pushAndCreatePrsParallel(
  shellRun: ShellRun,
  treeRoot: string,
  preparedGroups: PreparedProposalGroup[],
  concurrency: number,
): Promise<{ successes: number; failures: number; prUrls: string[] }> {
  const results: { success: boolean; prUrl?: string; error?: string }[] = [];
  const prUrls: string[] = [];

  for (let i = 0; i < preparedGroups.length; i += concurrency) {
    const batch = preparedGroups.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (prepared) => {
        const MAX_RETRIES = 2;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          const result = await pushAndCreatePr(shellRun, treeRoot, prepared);
          if (result.success) return result;

          // Check for rate limiting
          const isRateLimit = result.error?.includes("429") ||
            result.error?.toLowerCase().includes("rate") ||
            result.error?.toLowerCase().includes("too many");
          if (isRateLimit && attempt < MAX_RETRIES) {
            const waitSec = (attempt + 1) * 10;
            console.log(`  \u26A0 Rate limited. Retrying in ${waitSec}s... (attempt ${attempt + 2}/${MAX_RETRIES + 1})`);
            await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
            continue;
          }
          return result;
        }
        return { success: false, error: "Max retries exceeded" };
      }),
    );
    results.push(...batchResults);
  }

  let successes = 0;
  let failures = 0;
  for (const result of results) {
    if (result.success) {
      successes++;
      if (result.prUrl) prUrls.push(result.prUrl);
    } else {
      failures++;
      console.error(`\u274C ${result.error}`);
    }
  }

  return { successes, failures, prUrls };
}

export async function runSync(
  treeRoot: string,
  flags: Omit<ParsedFlags, "help" | "unknown" | "treePath">,
  deps: SyncDeps = {},
): Promise<number> {
  const shellRun = deps.shellRun ?? defaultShellRun;
  const now = deps.now ?? (() => new Date());
  const verifyTree = deps.verifyTree ?? ((root: string) => runVerify(new Repo(root)));
  const repo = new Repo(treeRoot);

  if (!repo.looksLikeTreeRepo()) {
    console.error(
      `\u274C ${treeRoot} does not look like a Context Tree repo. Run first-tree tree sync inside a tree repo, or pass --tree-path.`,
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
      "Once installed, re-run: first-tree tree sync --tree-path <path>",
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
  let hasConfigErrors = false;

  for (const binding of bindings) {
    if (!binding.remoteUrl) {
      console.error(
        `\u274C ${binding.sourceId}: no remoteUrl in binding file.\n` +
        `   Sync needs a GitHub URL to fetch commits and merged PRs.\n` +
        `   Fix: edit .first-tree/bindings/${binding.sourceId}.json and add:\n` +
        `     "remoteUrl": "https://github.com/<owner>/<repo>"\n` +
        `   Then re-run first-tree tree sync.`,
      );
      hasConfigErrors = true;
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

  if (hasConfigErrors && driftReports.length === 0) {
    return 1;
  }

  if (!flags.propose && !flags.apply) {
    return hasConfigErrors ? 1 : 0;
  }

  if (driftReports.length === 0) {
    console.log("nothing stale to propose.");
    return hasConfigErrors ? 1 : 0;
  }

  const CONCURRENCY = 10;

  for (const drift of driftReports) {
    // Classify per merged PR (not per batch) so each source PR → one tree PR
    const prsToClassify = drift.mergedPrs.length > 0
      ? drift.mergedPrs
      : [{
          number: 0,
          title: "unlinked commits",
          mergeCommitSha: null,
          mergedAt: "",
          authorLogin: null,
        }];

    // Phase 1: Classify all PRs in parallel (up to CONCURRENCY at a time)
    interface ClassifiedPr {
      pr: typeof prsToClassify[0];
      filtered: ClassificationItem[];
      written: string[];
    }
    const classifiedPrs: ClassifiedPr[] = [];

    console.log(
      `\nClassifying ${prsToClassify.length} source PR(s) for ${drift.binding.sourceId} (concurrency: ${CONCURRENCY})...`,
    );

    for (let i = 0; i < prsToClassify.length; i += CONCURRENCY) {
      const batch = prsToClassify.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (pr) => {
          const prLabel = pr.number > 0
            ? `PR #${pr.number} (${pr.title})`
            : "unlinked commits";

          // Build a per-PR drift report with only this PR's commits
          const prCommits = pr.number > 0
            ? drift.commits.filter((c) => {
                if (pr.mergeCommitSha && c.sha === pr.mergeCommitSha) return true;
                if (c.message.includes(`#${pr.number}`)) return true;
                return false;
              })
            : drift.commits;

          const perPrDrift: DriftReport = {
            ...drift,
            commits: prCommits.length > 0 ? prCommits : drift.commits.slice(0, 20),
            mergedPrTitles: [pr.title],
          };

          const prFileChanges = pr.number > 0
            ? await fetchPrFileChanges(shellRun, drift.ownerRepo, pr.number)
            : [];
          const prFiles = prFileChanges.map((f) => f.filename);
          const diffSummary = prFileChanges.length > 0
            ? formatPrDiffForPrompt(prFileChanges)
            : "";
          const proposals = await classifyDriftViaClaude(
            shellRun,
            perPrDrift,
            treeNodes,
            prFiles,
            diffSummary,
          );

          if (proposals.length === 0) {
            console.log(
              `  \u26A0 ${prLabel}: Claude returned empty response — no classification. This PR will be skipped.`,
            );
            return { pr, filtered: [] as ClassificationItem[], written: [] as string[] };
          }

          const dropped = proposals.filter(
            (p) => p.type !== "TREE_MISS" && p.type !== "TREE_OK",
          );
          for (const d of dropped) {
            console.log(
              `  \u26A0 ${prLabel}: dropping unsupported classification type "${d.type}" for path "${d.path}" (sync only applies TREE_MISS edits; see #125)`,
            );
          }
          const filtered = proposals.filter((p) => p.type === "TREE_MISS");
          const okCount = proposals.filter((p) => p.type === "TREE_OK").length;

          console.log(
            `  ${prLabel}: ${filtered.length} proposals (${okCount} TREE_OK skipped)`,
          );

          if (proposals.length > 0 && filtered.length === 0) {
            for (const p of proposals.slice(0, 3)) {
              console.log(`    - ${p.path ?? p.suggested_node_title ?? "(unnamed)"}: ${p.rationale ?? "(no rationale)"}`);
            }
          }

          const written: string[] = [];
          for (const item of filtered) {
            const path = writeProposalFile(repo.root, drift.binding.sourceId, drift, item);
            written.push(path);
          }

          return { pr, filtered, written };
        }),
      );
      classifiedPrs.push(...results);
    }

    // Deduplicate proposals that target the same node path across source PRs.
    // Strategy (#121): group all proposals by normalized target path, pick the
    // entry with the longest suggested body as the winner, drop the rest, and
    // annotate the winner with the losing source-PR numbers so the surviving
    // tree PR can credit every contributor in its body.
    interface DedupEntry {
      classified: ClassifiedPr;
      proposal: ClassificationItem;
    }
    const byPath = new Map<string, DedupEntry[]>();
    for (const classified of classifiedPrs) {
      for (const p of classified.filtered) {
        if (p.type !== "TREE_MISS") continue;
        const normPath = (p.path ?? "").replace(/\/NODE\.md$/i, "").replace(/^\//, "").toLowerCase();
        if (!normPath) continue;
        const list = byPath.get(normPath) ?? [];
        list.push({ classified, proposal: p });
        byPath.set(normPath, list);
      }
    }
    const winningProposals = new Set<ClassificationItem>();
    for (const [normPath, entries] of byPath) {
      if (entries.length === 1) {
        winningProposals.add(entries[0].proposal);
        continue;
      }
      // Rank by body length (stronger content first), then by source PR number
      // (oldest first) for stable ties.
      const ranked = [...entries].sort((a, b) => {
        const aLen = (a.proposal.suggested_node_body_markdown ?? "").length;
        const bLen = (b.proposal.suggested_node_body_markdown ?? "").length;
        if (aLen !== bLen) return bLen - aLen;
        const aNum = a.classified.pr.number ?? Number.MAX_SAFE_INTEGER;
        const bNum = b.classified.pr.number ?? Number.MAX_SAFE_INTEGER;
        return aNum - bNum;
      });
      const winner = ranked[0];
      winningProposals.add(winner.proposal);
      const coClaimants = ranked
        .slice(1)
        .map((e) => e.classified.pr.number)
        .filter((n): n is number => typeof n === "number" && n > 0);
      if (coClaimants.length > 0) {
        winner.proposal.coClaimingSourcePrs = Array.from(new Set(coClaimants)).sort((a, b) => a - b);
      }
      console.log(
        `  \u23ED Dedup: ${normPath} claimed by ${ranked.length} PR(s); kept PR #${winner.classified.pr.number} (body=${(winner.proposal.suggested_node_body_markdown ?? "").length} chars), dropped ${coClaimants.map((n) => `#${n}`).join(", ") || "(none)"}`,
      );
    }
    for (const classified of classifiedPrs) {
      classified.filtered = classified.filtered.filter(
        (p) => p.type !== "TREE_MISS" || winningProposals.has(p),
      );
    }

    const totalProposals = classifiedPrs.reduce((sum, c) => sum + c.filtered.length, 0);
    console.log(
      `\u2713 ${drift.binding.sourceId}: ${totalProposals} total proposal(s) across ${prsToClassify.length} source PR(s)`,
    );

    // Phase 2: Apply with parallelized push + PR creation
    // Branch creation and commits must be sequential, but push and PR create can be parallel.
    if (flags.apply) {
      const APPLY_CONCURRENCY = 5; // Concurrency for push + PR create (avoid rate limits)
      const groupsToApply = classifiedPrs.filter((c) => c.filtered.length > 0);
      const applyCount = groupsToApply.length;

      if (applyCount === 0) {
        console.log("\nNo tree PRs to apply.");
      } else {
        // Phase 2a: Prepare all branches sequentially (git checkout requires exclusive access)
        console.log(
          `\nPreparing ${applyCount} tree PR(s) (creating branches, committing locally)...`,
        );
        const preparedGroups: PreparedProposalGroup[] = [];
        // Accumulator for parent NODE.md `## Sub-domains` rollups across all
        // content groups in this drift (#188). Applied in the housekeeping
        // branch so sibling content PRs don't collide on the same parent file.
        const pendingParentAdditions = new Map<string, ParentSubDomainAddition[]>();
        const originalRef = await resolveStableCheckoutRef(shellRun, repo.root);
        if (originalRef === null) {
          return 1;
        }

        for (const { pr, filtered, written } of groupsToApply) {
          const group: ProposalGroup = {
            sourcePrNumber: pr.number > 0 ? pr.number : null,
            sourcePrTitle: pr.number > 0 ? pr.title : null,
            sourcePrAuthorLogin: pr.authorLogin,
            proposals: filtered,
            proposalPaths: written,
          };
          const prepared = await prepareProposalGroup(
            shellRun,
            repo.root,
            drift.binding,
            drift,
            group,
            originalRef,
            verifyTree,
            pendingParentAdditions,
          );
          if (prepared === null) {
            // Fatal error during preparation
            return 1;
          }
          if (prepared.skipped) {
            console.log(`  \u23ED ${prepared.branch}: ${prepared.skipReason}`);
          } else {
            console.log(`  \u2713 ${prepared.branch}: ready for push`);
            preparedGroups.push(prepared);
          }
        }

        // Return to original branch before parallel operations
        const restoreResult = await shellRun("git", ["checkout", originalRef], { cwd: repo.root });
        if (restoreResult.code !== 0) {
          console.error(`\u274C could not return to ${originalRef}: ${restoreResult.stderr.trim()}`);
          return 1;
        }

        if (flags.dryRun) {
          console.log(`\n(dry-run) would push ${preparedGroups.length} branch(es) and open PRs`);
          for (const prepared of preparedGroups) {
            console.log(`  - ${prepared.branch}: "${prepared.prTitle}"`);
          }
        } else if (preparedGroups.length > 0) {
          // Phase 2b: Push and create PRs in parallel
          console.log(
            `\nPushing ${preparedGroups.length} branch(es) and creating PRs (concurrency: ${APPLY_CONCURRENCY})...`,
          );
          const { successes, failures, prUrls } = await pushAndCreatePrsParallel(
            shellRun,
            repo.root,
            preparedGroups,
            APPLY_CONCURRENCY,
          );
          console.log(`\u2713 Push/PR phase complete: ${successes} succeeded, ${failures} failed`);
          for (const prUrl of prUrls) {
            console.log(`  - ${prUrl}`);
          }
          if (failures > 0) {
            console.error(`\u26A0 ${failures} PR(s) failed to create. Check errors above.`);
            return 1;
          }
        }

        // Open a housekeeping PR that only pins the binding.
        // CODEOWNERS used to live here too, but each content PR now regenerates
        // it (#119) so per-PR `generate-codeowners --check` passes without
        // waiting on housekeeping to merge.
        if (!flags.dryRun && preparedGroups.length > 0) {
          console.log("\nOpening housekeeping PR (binding pin)...");
          const hkBranch = `first-tree/sync-${drift.binding.sourceId}-housekeeping`;
          const hkCheckout = await shellRun("git", ["checkout", "-B", hkBranch, originalRef], { cwd: repo.root });
          if (hkCheckout.code !== 0) {
            console.error(`\u274C could not create housekeeping branch ${hkBranch}: ${hkCheckout.stderr.trim()}`);
            return 1;
          }

          // Pin the binding to the latest synced commit
          writeTreeBinding(repo.root, drift.binding.sourceId, {
            ...drift.binding,
            lastReconciledSourceCommit: drift.toSha,
            lastReconciledAt: now().toISOString(),
          });

          // Apply accumulated parent NODE.md `## Sub-domains` rollups here,
          // on the housekeeping branch (#188). Per-content branches used to
          // do this in-place and collide at merge time; centralizing here
          // makes the rollup idempotent (re-reads parent at current main
          // HEAD, skips already-listed children) and structurally
          // conflict-free (housekeeping merges last by design).
          const appliedRollups: string[] = [];
          for (const [parentPath, additions] of pendingParentAdditions) {
            if (!existsSync(parentPath)) continue;
            try {
              let parentContent = readFileSync(parentPath, "utf-8");
              let changed = false;
              for (const { dirName, title } of additions) {
                const newLine = `- \`${dirName}/\` — ${title}\n`;
                const subDomainsMatch = parentContent.match(/(##\s*Sub-?domains?[^\n]*\n)([\s\S]*?)(\n##|\n---|\z)/i);
                // Scope the scan to the ## Sub-domains block and match
                // the actual entry token — either `` `dir/` `` or
                // `[dir/](dir/NODE.md)`. Substring-with-word-boundary
                // still false-positived on hyphenated siblings like
                // `mobile-sidebar/` matching `sidebar/` because `-` is a
                // word boundary (#195 follow-up).
                if (subDomainsMatch) {
                  const block = subDomainsMatch[2];
                  const escaped = dirName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                  const backtickRe = new RegExp(`\`${escaped}/\``);
                  const linkRe = new RegExp(`\\[${escaped}/\\]\\(${escaped}/NODE\\.md\\)`);
                  if (backtickRe.test(block) || linkRe.test(block)) continue;
                }
                if (subDomainsMatch) {
                  const insertPoint = parentContent.indexOf(subDomainsMatch[0])
                    + subDomainsMatch[1].length
                    + subDomainsMatch[2].length;
                  parentContent = parentContent.slice(0, insertPoint) + newLine + parentContent.slice(insertPoint);
                } else {
                  const trimmed = parentContent.replace(/\s+$/, "");
                  parentContent = `${trimmed}\n\n## Sub-domains\n\n${newLine}`;
                }
                changed = true;
                appliedRollups.push(`${relative(repo.root, parentPath)} ← ${dirName}/`);
              }
              if (changed) {
                writeFileSync(parentPath, parentContent);
                console.log(`  \u2713 Housekeeping rollup: ${relative(repo.root, parentPath)}`);
              }
            } catch { /* non-fatal */ }
          }

          await shellRun("git", ["add", "-A"], { cwd: repo.root });
          const hkDiff = await shellRun("git", ["diff", "--cached", "--quiet"], { cwd: repo.root });
          if (hkDiff.code !== 0) {
            await shellRun("git", ["commit", "-m", `chore(sync): pin ${drift.binding.sourceId} to ${drift.toSha.slice(0, 7)}`], { cwd: repo.root });
            await shellRun("git", ["push", "origin", "HEAD"], { cwd: repo.root });
            const rollupBody = appliedRollups.length > 0
              ? [
                  "",
                  "## Sub-domains rollup",
                  "",
                  "This run introduced new child nodes; parent `NODE.md` navigation",
                  "sections are updated here (not in per-content branches) to avoid",
                  "merge conflicts between sibling sync PRs (#188).",
                  "",
                  ...appliedRollups.map((r) => `- ${r}`),
                ].join("\n")
              : "";
            const hkPr = await shellRun("gh", [
              "pr", "create",
              "--title", `chore(sync): housekeeping for ${drift.binding.sourceId}`,
              "--body", [
                "Housekeeping PR — pins the sync bookmark.",
                "",
                "**Merge this AFTER all sync PRs are merged.**",
                "",
                `Pins \`lastReconciledSourceCommit\` to \`${drift.toSha.slice(0, 7)}\`.`,
                "",
                "CODEOWNERS is regenerated inside each content PR, so no CODEOWNERS diff is expected here.",
                rollupBody,
              ].join("\n"),
            ], { cwd: repo.root });
            if (hkPr.code === 0) {
              console.log(`\u2713 Housekeeping PR opened: ${hkPr.stdout.trim()}`);
              console.log("  Merge this AFTER all other sync PRs are merged.");
            }
          } else {
            console.log("  No changes for housekeeping PR.");
          }
          const restoreAfterHousekeeping = await shellRun("git", ["checkout", originalRef], { cwd: repo.root });
          if (restoreAfterHousekeeping.code !== 0) {
            console.error(`\u274C could not return to ${originalRef}: ${restoreAfterHousekeeping.stderr.trim()}`);
            return 1;
          }
        } else if (flags.dryRun && preparedGroups.length > 0) {
          console.log(`\n(dry-run) would open housekeeping PR to pin binding to ${drift.toSha.slice(0, 7)}`);
        }
      }
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
