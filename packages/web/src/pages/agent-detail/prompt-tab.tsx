import { Navigate, useNavigate } from "react-router";
import { Button } from "../../components/ui/button.js";
import { Section } from "../../components/ui/section.js";
import { useAgentDetailContext } from "./layout-context.js";

export function PromptTab() {
  const ctx = useAgentDetailContext();
  const navigate = useNavigate();
  if (ctx.isHuman) return <Navigate to="../profile" replace />;
  if (!ctx.config && ctx.configLoading) return null;
  const prompt = ctx.config?.payload.prompt.append ?? "";
  return (
    <Section
      title="Effective prompt"
      description="Resolved from Team and Agent prompt resources."
      action={
        ctx.canManageAgent ? (
          <Button type="button" size="xs" variant="outline" onClick={() => navigate("../resources")}>
            Edit resources
          </Button>
        ) : null
      }
    >
      {prompt ? (
        <pre
          className="whitespace-pre-wrap text-body"
          style={{
            margin: 0,
            padding: "var(--sp-3) 0",
            borderBottom: "var(--hairline) solid var(--border-faint)",
            color: "var(--fg-2)",
          }}
        >
          {prompt}
        </pre>
      ) : (
        <p className="text-body" style={{ color: "var(--fg-4)", margin: 0, padding: "var(--sp-3) 0" }}>
          No prompt resources enabled.
        </p>
      )}
    </Section>
  );
}
