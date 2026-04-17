/**
 * TS port of `RepoFilter` from
 * `first-tree-breeze/breeze-runner/src/config.rs:39-114`.
 *
 * Allow-list with two shapes:
 *   - `owner/repo`  → exact match
 *   - `owner/*`     → all repos under `owner`
 *
 * Empty filter = "match everything". Used to scope notification polls,
 * search queries, and snapshot hydration.
 */

export class RepoFilter {
  private readonly allowedOwners: string[];
  private readonly allowedRepos: string[];

  private constructor(owners: string[], repos: string[]) {
    this.allowedOwners = owners;
    this.allowedRepos = repos;
  }

  static empty(): RepoFilter {
    return new RepoFilter([], []);
  }

  /**
   * Parse a comma-separated list. Throws on an invalid pattern (not
   * `owner/repo` and not `owner/*`).
   */
  static parseCsv(value: string): RepoFilter {
    const owners: string[] = [];
    const repos: string[] = [];
    for (const raw of value.split(",")) {
      const trimmed = raw.trim();
      if (trimmed.length === 0) continue;
      if (trimmed.endsWith("/*")) {
        const owner = trimmed.slice(0, -2);
        if (owner.length === 0) {
          throw new Error(`invalid repo allow pattern \`${trimmed}\``);
        }
        if (!owners.includes(owner)) owners.push(owner);
        continue;
      }
      if (trimmed.split("/").length === 2) {
        if (!repos.includes(trimmed)) repos.push(trimmed);
        continue;
      }
      throw new Error(
        `invalid repo allow pattern \`${trimmed}\`; use owner/repo or owner/*`,
      );
    }
    return new RepoFilter(owners, repos);
  }

  merge(other: RepoFilter): RepoFilter {
    const owners = [...this.allowedOwners];
    const repos = [...this.allowedRepos];
    for (const o of other.allowedOwners) {
      if (!owners.includes(o)) owners.push(o);
    }
    for (const r of other.allowedRepos) {
      if (!repos.includes(r)) repos.push(r);
    }
    return new RepoFilter(owners, repos);
  }

  isEmpty(): boolean {
    return this.allowedOwners.length === 0 && this.allowedRepos.length === 0;
  }

  matchesRepo(repo: string): boolean {
    if (this.isEmpty()) return true;
    if (this.allowedRepos.includes(repo)) return true;
    const slash = repo.indexOf("/");
    if (slash <= 0) return false;
    const owner = repo.slice(0, slash);
    return this.allowedOwners.includes(owner);
  }

  owners(): readonly string[] {
    return this.allowedOwners;
  }

  repos(): readonly string[] {
    return this.allowedRepos;
  }

  /** Human-readable patterns joined by `, `. */
  displayPatterns(): string {
    return [
      ...this.allowedRepos,
      ...this.allowedOwners.map((o) => `${o}/*`),
    ].join(", ");
  }

  /** CLI-shaped value (comma-separated). */
  cliValue(): string {
    return [
      ...this.allowedRepos,
      ...this.allowedOwners.map((o) => `${o}/*`),
    ].join(",");
  }
}

export type SearchScope =
  | { kind: "all" }
  | { kind: "owner"; owner: string }
  | { kind: "repo"; repo: string };

/**
 * Compute the list of `gh search` scopes implied by a filter. Matches
 * `GhClient::search_scopes` in Rust: empty filter → `[All]`; owners
 * + explicit repos each get their own scope.
 */
export function searchScopesFor(filter: RepoFilter): SearchScope[] {
  if (filter.isEmpty()) return [{ kind: "all" }];
  const scopes: SearchScope[] = [];
  for (const owner of filter.owners()) {
    scopes.push({ kind: "owner", owner });
  }
  for (const repo of filter.repos()) {
    scopes.push({ kind: "repo", repo });
  }
  if (scopes.length === 0) return [{ kind: "all" }];
  return scopes;
}
