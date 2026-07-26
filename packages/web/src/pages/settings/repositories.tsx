import { useEffect, useRef } from "react";
import { Navigate, useLocation } from "react-router";
import { useAuth } from "../../auth/auth-context.js";
import { ResourceTypeSections } from "./resource-sections.js";

const CODE_REPOSITORIES_HASH = "#code-repositories";
const CONTEXT_TREE_HASH = "#context-tree";

/**
 * Settings → Repositories is the provider-neutral catalog of code available to
 * agents. Context Tree binding and Automatic Review owner controls live in the
 * canonical Settings → Setup surface.
 */
export function SettingsRepositoriesPage() {
  const { role } = useAuth();
  const location = useLocation();
  const codeRepositoriesRef = useRef<HTMLElement>(null);

  // React Router updates the fragment but not the app shell's persistent
  // overflow container. Position and focus the code catalog explicitly.
  useEffect(() => {
    if (role === null) return;
    const target = location.hash === CODE_REPOSITORIES_HASH ? codeRepositoriesRef.current : null;
    if (!target) return;
    target.scrollIntoView({ block: "start" });
    target.focus({ preventScroll: true });
  }, [location.hash, role]);

  if (location.hash === CONTEXT_TREE_HASH) {
    return <Navigate to="/settings/setup#context-tree" replace />;
  }

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
    </div>
  );
}
