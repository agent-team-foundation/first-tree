import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type SkillDescriptor, skillDescriptorSchema } from "@first-tree/shared";
import { parse as parseYaml } from "yaml";

type WarnFn = (msg: string) => void;

/**
 * Discover slash-command skills available to a Claude Code runtime on this
 * machine. The web composer reads these via
 * `GET /api/v1/agents/:uuid/skills` to render the `/`-triggered popover
 * after the user `@mentions` the agent.
 *
 * Phase 1B scope: scan only user-global skill paths
 *   - `<home>/.claude/skills/<name>/SKILL.md`            (source: "user")
 *   - `<home>/.claude/plugins/<plugin>/skills/<name>/SKILL.md`  (source: "plugin")
 *
 * Project-local skills (under each agent's repo) require knowing the
 * per-agent workspace — deferred to a later phase. Every claude-code agent
 * on this client gets the same user-global list as a Phase 1B
 * approximation.
 */
export async function discoverClaudeCodeSkills(opts?: {
  /** Override for tests. Defaults to the real `$HOME`. */
  home?: string;
  /** Surface non-fatal scan warnings (malformed frontmatter, unreadable file, etc.). */
  warn?: WarnFn;
}): Promise<SkillDescriptor[]> {
  const home = opts?.home ?? homedir();
  const warn = opts?.warn ?? (() => {});

  const out: SkillDescriptor[] = [];

  const userSkillsRoot = join(home, ".claude", "skills");
  out.push(...scanSkillsDir(userSkillsRoot, { source: "user" }, warn));

  const pluginsRoot = join(home, ".claude", "plugins");
  if (existsSync(pluginsRoot)) {
    let pluginDirs: string[];
    try {
      pluginDirs = readdirSync(pluginsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch (err) {
      warn(`cannot enumerate ${pluginsRoot}: ${errMsg(err)}`);
      pluginDirs = [];
    }
    for (const plugin of pluginDirs) {
      const skillsRoot = join(pluginsRoot, plugin, "skills");
      out.push(...scanSkillsDir(skillsRoot, { source: "plugin", namespace: plugin }, warn));
    }
  }

  // Stable ordering for deterministic upload payloads — keeps the
  // content-hash short-circuit on the caller side meaningful.
  out.sort((a, b) => {
    const an = a.namespace ?? "";
    const bn = b.namespace ?? "";
    if (an !== bn) return an < bn ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  return out;
}

function scanSkillsDir(
  root: string,
  defaults: { source: SkillDescriptor["source"]; namespace?: string },
  warn: WarnFn,
): SkillDescriptor[] {
  if (!existsSync(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    warn(`cannot enumerate ${root}: ${errMsg(err)}`);
    return [];
  }

  const out: SkillDescriptor[] = [];
  for (const name of entries) {
    const skillFile = join(root, name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const parsed = parseSkillFile(skillFile, warn);
    if (!parsed) continue;
    const candidate: SkillDescriptor = {
      // Frontmatter `name:` wins when present; fall back to the directory
      // name so a SKILL.md without a `name:` field is still discoverable.
      name: parsed.name ?? name,
      description: parsed.description,
      source: defaults.source,
      ...(defaults.namespace ? { namespace: defaults.namespace } : {}),
    };
    const validated = skillDescriptorSchema.safeParse(candidate);
    if (validated.success) {
      out.push(validated.data);
    } else {
      warn(`${skillFile}: descriptor failed validation — ${validated.error.message}`);
    }
  }
  return out;
}

/**
 * Extract the `---\n...\n---` YAML frontmatter from a SKILL.md file. We
 * only need `name` + `description`; other fields are ignored on purpose so
 * skill authors can add metadata without us tracking it.
 */
function parseSkillFile(path: string, warn: WarnFn): { name?: string; description: string } | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    warn(`${path}: cannot read — ${errMsg(err)}`);
    return null;
  }

  // Frontmatter must be the very first thing in the file.
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!match) {
    warn(`${path}: missing YAML frontmatter block`);
    return null;
  }

  let fm: unknown;
  try {
    fm = parseYaml(match[1] ?? "");
  } catch (err) {
    warn(`${path}: malformed YAML frontmatter — ${errMsg(err)}`);
    return null;
  }
  if (!isPlainObject(fm)) {
    warn(`${path}: YAML frontmatter is not an object`);
    return null;
  }

  const description = fm.description;
  if (typeof description !== "string" || description.length === 0) {
    warn(`${path}: missing required \`description\` field in frontmatter`);
    return null;
  }
  const name = fm.name;
  return {
    name: typeof name === "string" && name.length > 0 ? name : undefined,
    description,
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
