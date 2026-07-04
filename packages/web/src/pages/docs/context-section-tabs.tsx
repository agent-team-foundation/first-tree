import { useNavigate } from "react-router";
import { useAuth } from "../../auth/auth-context.js";
import { SegmentedControl } from "../../components/ui/segmented-control.js";

/**
 * Context-surface section switcher: the Context Tree view and the document
 * library (docloop) share the Context top-level tab — the library is the
 * team's raw shared-memory layer, review included. Hidden entirely when the
 * deployment has the docs feature off.
 */
export function ContextSectionTabs({ active }: { active: "tree" | "docs" }) {
  const navigate = useNavigate();
  const { docsEnabled } = useAuth();
  if (!docsEnabled) return null;
  return (
    <div style={{ padding: "0 var(--sp-5) var(--sp-2)" }}>
      <SegmentedControl
        options={[
          { value: "tree", label: "Context Tree" },
          { value: "docs", label: "Documents" },
        ]}
        value={active}
        onChange={(next) => navigate(next === "tree" ? "/context" : "/context/docs")}
      />
    </div>
  );
}
