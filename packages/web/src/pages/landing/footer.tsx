const REPO_URL = "https://github.com/agent-team-foundation/first-tree";
const PARENT_URL = "https://first-tree.ai";

/**
 * Minimal footer.
 *
 * Left: parent-brand attribution `@ first-tree` linking to first-tree.ai —
 * First Tree Hub is a sub-product of first-tree, so the marketing entry
 * point credits the parent rather than itself.
 *
 * Right: GitHub repo link. Resisted the urge to add npm / docs links per
 * spec ("only GitHub, keep it minimal"); the parent brand link doubles as
 * discovery for anyone who wants to know what first-tree is.
 */
export function Footer() {
  return (
    <footer className="border-t border-border/60">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center justify-between gap-3 px-6 py-8 sm:flex-row">
        <a
          href={PARENT_URL}
          target="_blank"
          rel="noreferrer noopener"
          className="rounded-[var(--radius-input)] text-caption text-fg-3 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          @ first-tree
        </a>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer noopener"
          className="rounded-[var(--radius-input)] text-body text-fg-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          GitHub →
        </a>
      </div>
    </footer>
  );
}
