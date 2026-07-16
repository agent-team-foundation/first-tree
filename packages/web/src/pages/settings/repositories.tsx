import { useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { useAuth } from "../../auth/auth-context.js";
import { ContextTreeSettingsPanel } from "../context-tree-settings-panel.js";
import { ResourceTypeSections } from "./resource-sections.js";

const CODE_REPOSITORIES_HASH = "#code-repositories";
const CONTEXT_TREE_HASH = "#context-tree";

/**
 * Settings → Repositories. One provider-neutral home for the repositories
 * available to agents and the separate organization Context Tree binding.
 *
 * The two models deliberately share a page without sharing state: Team repo
 * resources are runtime inputs, while `context_tree` remains the single
 * organization pointer used by Context and agent startup.
 */
export function SettingsRepositoriesPage() {
  const { role } = useAuth();
  const location = useLocation();
  const codeRepositoriesRef = useRef<HTMLElement>(null);
  const contextTreeRef = useRef<HTMLElement>(null);

  // React Router updates the fragment but not the app shell's persistent
  // overflow container. Position and focus either section explicitly so old
  // Context links and Agent Detail exits remain deterministic.
  useEffect(() => {
    if (role === null) return;
    const target =
      location.hash === CODE_REPOSITORIES_HASH
        ? codeRepositoriesRef.current
        : location.hash === CONTEXT_TREE_HASH
          ? contextTreeRef.current
          : null;
    if (!target) return;
    target.scrollIntoView({ block: "start" });
    target.focus({ preventScroll: true });
  }, [location.hash, role]);

  if (role === null) {
    return (
      <div className="text-body" style={{ padding: "var(--sp-5)", color: "var(--fg-3)" }}>
        Loading...
      </div>
    );
  }

  return (
    <div style={{ padding: "var(--sp-2) var(--sp-5) var(--sp-7)" }}>
      <section
        ref={codeRepositoriesRef}
        id={CODE_REPOSITORIES_HASH.slice(1)}
        tabIndex={-1}
        aria-label="Code repositories"
        style={{ scrollMarginTop: "var(--sp-4)" }}
      >
        <ResourceTypeSections
          types={["repo"]}
          titleFor={() => "Code repositories"}
          descriptionFor={() =>
            "Repositories your agents can read and change. Private access uses Git credentials on each agent computer."
          }
          addLabelFor={() => "Add repository"}
          emptyLabelFor={() => "No code repositories configured yet."}
          compactLimit={3}
        />
      </section>

      <section
        ref={contextTreeRef}
        id={CONTEXT_TREE_HASH.slice(1)}
        tabIndex={-1}
        aria-label="Context Tree"
        style={{ marginTop: "var(--sp-7)", scrollMarginTop: "var(--sp-4)" }}
      >
        <ContextTreeSettingsPanel />
      </section>
    </div>
  );
}
