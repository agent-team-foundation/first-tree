import { ChevronRight, Cpu, Plug } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { PageHeader } from "../components/ui/page-header.js";
import { Panel } from "../components/ui/panel.js";

/**
 * Settings hub. The top-level sidebar items are intentionally minimal
 * (Workspace / Context / Team / Settings). Settings absorbs the secondary
 * surfaces — connecting computers and managing platform integrations —
 * so they do not each occupy a top-level slot.
 */
export function SettingsPage() {
  const navigate = useNavigate();

  return (
    <div className="-m-6">
      <PageHeader title="Settings" subtitle="Computers and platform integrations" />
      <div
        className="grid grid-cols-1 md:grid-cols-2"
        style={{
          gap: "var(--sp-3)",
          padding: "var(--sp-4) var(--sp-5) var(--sp-7)",
        }}
      >
        <SettingsCard
          icon={<Cpu className="h-4 w-4" />}
          title="Computers"
          description="Pair the machines that host your agent runtimes — view their status, capabilities, and disconnect when needed."
          onClick={() => navigate("/clients")}
        />
        <SettingsCard
          icon={<Plug className="h-4 w-4" />}
          title="Integrations"
          description="Connect external platforms (Slack, Feishu, …) so agents can be reached from the tools your team already uses."
          onClick={() => navigate("/integrations")}
        />
      </div>
    </div>
  );
}

function SettingsCard({
  icon,
  title,
  description,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <Panel>
      <button
        type="button"
        onClick={onClick}
        className="text-left transition-colors w-full"
        style={{
          display: "block",
          padding: "var(--sp-4) var(--sp-4)",
          background: "transparent",
          border: "none",
          cursor: "pointer",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--bg-hover)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
        }}
      >
        <div className="flex items-center" style={{ gap: 8, marginBottom: "var(--sp-1_5)", color: "var(--fg)" }}>
          {icon}
          <span className="text-subtitle font-medium">{title}</span>
          <div style={{ flex: 1 }} />
          <ChevronRight className="h-4 w-4" style={{ color: "var(--fg-4)" }} />
        </div>
        <div className="text-body" style={{ color: "var(--fg-3)" }}>
          {description}
        </div>
      </button>
    </Panel>
  );
}
