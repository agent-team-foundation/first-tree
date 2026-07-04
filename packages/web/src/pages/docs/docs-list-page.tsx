import type { DocStatus, DocSummary } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { FileText, MessageSquare } from "lucide-react";
import { useMemo, useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { listDocs } from "../../api/docs.js";
import { useAuth } from "../../auth/auth-context.js";
import { Input } from "../../components/ui/input.js";
import { PageHeader } from "../../components/ui/page-header.js";
import { Select } from "../../components/ui/select.js";
import { formatRelative } from "../../lib/utils.js";
import { ContextSectionTabs } from "./context-section-tabs.js";
import { DOC_STATUS_LABELS, DocAuthorLabel, DocStatusChip } from "./doc-meta.js";

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "in_review", label: DOC_STATUS_LABELS.in_review },
  { value: "draft", label: DOC_STATUS_LABELS.draft },
  { value: "approved", label: DOC_STATUS_LABELS.approved },
  { value: "archived", label: DOC_STATUS_LABELS.archived },
];

/**
 * Document library (docloop) list. Status filters go to the server; the
 * search box narrows the loaded page client-side across title/slug/project —
 * server-side full-text search is the M3 upgrade path.
 */
export function DocsListPage() {
  const navigate = useNavigate();
  const { organizationId, docsEnabled } = useAuth();
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");

  const status = statusFilter === "all" ? undefined : (statusFilter as DocStatus);
  const query = useQuery({
    queryKey: ["docs", organizationId, status ?? "all"],
    queryFn: () => listDocs({ status, limit: 200 }),
    enabled: !!organizationId && docsEnabled,
  });

  const items = useMemo(() => {
    const all = query.data?.items ?? [];
    const needle = search.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((doc) =>
      [doc.title, doc.slug, doc.project ?? ""].some((field) => field.toLowerCase().includes(needle)),
    );
  }, [query.data, search]);

  // Deep links while the deployment flag is off land on the Context tree
  // view instead of a half-broken page (the server 404s the API anyway).
  if (!docsEnabled) {
    return <Navigate to="/context" replace />;
  }

  return (
    <>
      <PageHeader
        title="Documents"
        subtitle="Design docs published for team review — the raw layer of shared memory."
      />
      <ContextSectionTabs active="docs" />
      <div style={{ padding: "0 var(--sp-5) var(--sp-5)" }}>
        <div className="flex items-center gap-2" style={{ marginBottom: "var(--sp-3)", maxWidth: 720 }}>
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter by title, slug, or project…"
            aria-label="Filter documents"
          />
          <Select
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUS_FILTERS}
            aria-label="Status filter"
            triggerClassName="w-40"
          />
        </div>

        {query.isLoading ? (
          <p className="text-label" style={{ color: "var(--fg-3)" }}>
            Loading documents…
          </p>
        ) : null}
        {query.error ? (
          <p className="text-label" style={{ color: "var(--danger)" }}>
            {query.error instanceof Error ? query.error.message : "Failed to load documents"}
          </p>
        ) : null}
        {!query.isLoading && !query.error && items.length === 0 ? (
          <div
            className="flex flex-col items-center gap-2 text-label"
            style={{ color: "var(--fg-3)", padding: "var(--sp-5) 0" }}
          >
            <FileText size={20} />
            <span>
              {search
                ? "No documents match the filter."
                : "No documents yet. Agents publish with `first-tree doc publish <file>`."}
            </span>
          </div>
        ) : null}

        <div className="flex flex-col" style={{ gap: 2 }}>
          {items.map((doc) => (
            <DocRow key={doc.id} doc={doc} onOpen={() => navigate(`/context/docs/${encodeURIComponent(doc.slug)}`)} />
          ))}
        </div>
      </div>
    </>
  );
}

function DocRow({ doc, onOpen }: { doc: DocSummary; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex items-center gap-3 rounded-[var(--radius-input)] text-left hover:bg-[var(--bg-hover)]"
      style={{ padding: "var(--sp-2) var(--sp-3)", border: "none", background: "transparent", cursor: "pointer" }}
    >
      <FileText size={16} style={{ color: "var(--fg-3)", flexShrink: 0 }} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate font-medium" style={{ color: "var(--fg)" }}>
            {doc.title}
          </span>
          <span className="text-caption" style={{ color: "var(--fg-3)" }}>
            {doc.slug}
          </span>
        </div>
        <div className="flex items-center gap-2 text-caption" style={{ color: "var(--fg-3)" }}>
          {doc.project ? <span>{doc.project}</span> : null}
          <span>v{doc.latestVersion}</span>
          <DocAuthorLabel author={doc.createdBy} />
          <span>{formatRelative(doc.updatedAt)}</span>
        </div>
      </div>
      {doc.openCommentCount > 0 ? (
        <span className="inline-flex items-center gap-1 text-caption" style={{ color: "var(--fg-2)" }}>
          <MessageSquare size={13} />
          {doc.openCommentCount}
        </span>
      ) : null}
      <DocStatusChip status={doc.status} />
    </button>
  );
}
