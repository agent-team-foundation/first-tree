import type { OrgContextTreeInput, OrgContextTreeOutput, SetupContextTreeBinding } from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { getRawContextTreeSetting, putContextTreeSetting } from "../../api/org-settings.js";
import { setupCapabilitiesQueryKey } from "../../api/setup-capabilities.js";
import { useAuth } from "../../auth/auth-context.js";
import { Button } from "../../components/ui/button.js";
import { SettingsField, SettingsSaveButton } from "../../components/ui/settings-field.js";
import { ContextTreeBuildEntry } from "../context-tree-build-entry.js";

type ContextTreeAvailability = "active" | "stale" | "unavailable" | "checking" | "unknown" | null;

export function SetupContextTreeControls({
  binding,
  availability,
  loadSetting = getRawContextTreeSetting,
  saveSetting = putContextTreeSetting,
  refreshFacts,
  children,
}: {
  binding: SetupContextTreeBinding;
  availability: ContextTreeAvailability;
  loadSetting?: (organizationId: string) => Promise<OrgContextTreeOutput>;
  saveSetting?: (organizationId: string, input: OrgContextTreeInput) => Promise<OrgContextTreeOutput>;
  refreshFacts?: (organizationId: string) => Promise<void>;
  children?: ReactNode;
}) {
  const { organizationId, role } = useAuth();
  const isAdmin = role === "admin";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [saved, setSaved] = useState(false);
  const [savedBinding, setSavedBinding] = useState<OrgContextTreeOutput | null>(null);
  const savedTimeout = useRef<number | null>(null);

  const settingQuery = useQuery({
    queryKey: ["org-setting", organizationId, "context_tree", "raw"],
    queryFn: () => (organizationId ? loadSetting(organizationId) : Promise.reject(new Error("no organization"))),
    enabled: isAdmin && !!organizationId,
  });

  useEffect(() => {
    if (!settingQuery.data) return;
    setRepo(settingQuery.data.repo ?? "");
    setBranch(settingQuery.data.branch ?? "main");
  }, [settingQuery.data]);

  useEffect(
    () => () => {
      if (savedTimeout.current !== null) window.clearTimeout(savedTimeout.current);
    },
    [],
  );

  const mutation = useMutation({
    mutationFn: () => {
      if (!organizationId) throw new Error("organization not loaded");
      return saveSetting(organizationId, {
        provider: null,
        repo: repo.trim() || null,
        branch: branch.trim() || null,
      });
    },
    onSuccess: (next) => {
      queryClient.setQueryData(["org-setting", organizationId, "context_tree", "raw"], next);
      setSavedBinding(next);
      if (refreshFacts && organizationId) {
        void refreshFacts(organizationId);
      } else {
        void queryClient.invalidateQueries({ queryKey: setupCapabilitiesQueryKey(organizationId) });
        void queryClient.invalidateQueries({ queryKey: ["context-tree-snapshot", organizationId] });
      }
      setSaved(true);
      if (savedTimeout.current !== null) window.clearTimeout(savedTimeout.current);
      savedTimeout.current = window.setTimeout(() => setSaved(false), 2000);
    },
  });

  if (!isAdmin) return null;

  const hasBoundTree = binding.state === "bound";
  const chatIntent = hasBoundTree ? "recover" : "build";
  const shouldOfferChat = binding.state === "unbound" || (hasBoundTree && availability === "unavailable");
  const bindingSummary = savedBinding?.repo
    ? `${repositoryLabel(savedBinding.repo)} · ${savedBinding.branch ?? "main"} branch · ${
        savedBinding.provider ?? "provider pending"
      }`
    : binding.state === "bound"
      ? `${repositoryLabel(binding.repo)} · ${binding.branch} branch · ${binding.provider}`
      : null;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    mutation.mutate();
  };

  return (
    <div
      data-setup-owner-controls="context-tree"
      className="flex flex-col"
      style={{
        gap: "var(--sp-3)",
        padding: "var(--sp-4)",
        border: "var(--hairline) solid var(--border)",
        borderRadius: "var(--radius-panel)",
        background: "var(--bg-sunken)",
      }}
    >
      {bindingSummary ? (
        <div className="flex min-w-0 flex-wrap items-center justify-between" style={{ gap: "var(--sp-3)" }}>
          <span className="text-label min-w-0" style={{ color: "var(--fg-3)", overflowWrap: "anywhere" }}>
            {bindingSummary}
          </span>
          <Button type="button" variant="link" className="h-auto shrink-0 p-0" onClick={() => navigate("/context")}>
            <span>Open Context</span>
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      ) : null}

      {shouldOfferChat ? <ContextTreeBuildEntry intent={chatIntent} /> : null}

      <div>
        <Button
          type="button"
          variant="link"
          className="h-auto p-0"
          style={{ color: "var(--fg-3)" }}
          onClick={() => setEditing((current) => !current)}
        >
          {editing
            ? "Close binding editor"
            : hasBoundTree
              ? "Change repository or branch"
              : "Already have a tree repo? Bind it manually"}
        </Button>
      </div>

      {editing ? (
        settingQuery.isLoading ? (
          <div className="text-label" style={{ color: "var(--fg-3)" }}>
            Loading binding…
          </div>
        ) : settingQuery.error ? (
          <div role="alert" className="text-label" style={{ color: "var(--state-error)" }}>
            {settingQuery.error instanceof Error ? settingQuery.error.message : "Failed to load Context Tree binding"}
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <SettingsField
              label="Repo URL"
              hint="HTTPS or SSH URL of the Context Tree git repository for this team."
              value={repo}
              onChange={setRepo}
              mono
              placeholder="https://github.com/your-org/first-tree-context"
            />
            <SettingsField
              label="Branch"
              hint="Branch agents use for new Context Tree tasks."
              value={branch}
              onChange={setBranch}
              mono
              placeholder="main"
              saved={saved}
              rightSlot={<SettingsSaveButton pending={mutation.isPending} disabled={!settingQuery.data} />}
            />
            {mutation.error instanceof Error ? (
              <div role="alert" className="text-label" style={{ color: "var(--state-error)" }}>
                {mutation.error.message}
              </div>
            ) : null}
          </form>
        )
      ) : null}

      {children ? (
        <div
          style={{
            paddingTop: "var(--sp-4)",
            borderTop: "var(--hairline) solid var(--border-faint)",
          }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

function repositoryLabel(repo: string): string {
  try {
    const url = new URL(repo);
    return url.pathname.replace(/^\/|\.git$/g, "") || url.hostname;
  } catch {
    return repo.replace(/^git@[^:]+:/, "").replace(/\.git$/, "");
  }
}
