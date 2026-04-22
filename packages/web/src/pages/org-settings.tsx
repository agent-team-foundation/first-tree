import { SYSTEM_CONFIG_DEFAULTS, SYSTEM_CONFIG_KEYS } from "@agent-team-foundation/first-tree-hub-shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { getConfigs, updateConfigs } from "../api/system-config.js";
import { Button } from "../components/ui/button.js";
import { Panel, PanelHeader, PanelTitle } from "../components/ui/panel.js";
import { UppercaseLabel } from "../components/ui/section-header.js";

type ConfigMeta = {
  key: string;
  label: string;
  description: string;
  unit: string | null;
};

const CONFIG_FIELDS: ConfigMeta[] = [
  {
    key: SYSTEM_CONFIG_KEYS.INBOX_TIMEOUT_SECONDS,
    label: "Inbox timeout",
    description: "How long an agent waits for inbound messages before sleeping.",
    unit: "seconds",
  },
  {
    key: SYSTEM_CONFIG_KEYS.MAX_RETRY_COUNT,
    label: "Max retry count",
    description: "Delivery attempts before a message is marked failed.",
    unit: null,
  },
  {
    key: SYSTEM_CONFIG_KEYS.POLLING_INTERVAL_SECONDS,
    label: "Polling interval",
    description: "Runtime heartbeat cadence for offline detection.",
    unit: "seconds",
  },
  {
    key: SYSTEM_CONFIG_KEYS.PRESENCE_CLEANUP_SECONDS,
    label: "Presence cleanup",
    description: "When presence rows expire after disconnect.",
    unit: "seconds",
  },
];

const configKeys = CONFIG_FIELDS.map((c) => c.key);

export function OrgSettingsPage() {
  const queryClient = useQueryClient();
  const { data: configs, isLoading } = useQuery({
    queryKey: ["system-config"],
    queryFn: getConfigs,
  });

  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!configs) return;
    const map: Record<string, string> = {};
    for (const key of configKeys) {
      const val = configs[key] ?? SYSTEM_CONFIG_DEFAULTS[key as keyof typeof SYSTEM_CONFIG_DEFAULTS] ?? "";
      map[key] = String(val);
    }
    setValues(map);
  }, [configs]);

  const mutation = useMutation({
    mutationFn: () => {
      const payload: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(values)) {
        const trimmed = val.trim();
        if (trimmed === "") {
          payload[key] = SYSTEM_CONFIG_DEFAULTS[key as keyof typeof SYSTEM_CONFIG_DEFAULTS] ?? 0;
        } else {
          const num = Number(trimmed);
          payload[key] = Number.isNaN(num) ? trimmed : num;
        }
      }
      return updateConfigs(payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["system-config"] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  function handleReset() {
    const map: Record<string, string> = {};
    for (const key of configKeys) {
      map[key] = String(SYSTEM_CONFIG_DEFAULTS[key as keyof typeof SYSTEM_CONFIG_DEFAULTS] ?? "");
    }
    setValues(map);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    mutation.mutate();
  }

  return (
    <form onSubmit={handleSubmit}>
      <Panel>
        <PanelHeader>
          <PanelTitle>System configuration</PanelTitle>
          <div className="flex items-center gap-1.5">
            {saved && (
              <span className="mono" style={{ fontSize: 10.5, color: "var(--accent-dim)" }}>
                saved
              </span>
            )}
            <Button type="button" variant="ghost" size="xs" onClick={handleReset} disabled={mutation.isPending}>
              Reset defaults
            </Button>
            <Button type="submit" size="xs" disabled={mutation.isPending}>
              <Check className="h-3 w-3" />
              {mutation.isPending ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </PanelHeader>
        <div style={{ padding: "4px 16px 14px" }}>
          {isLoading ? (
            <div className="py-6" style={{ color: "var(--fg-3)", fontSize: 12 }}>
              Loading…
            </div>
          ) : (
            CONFIG_FIELDS.map((field) => (
              <ConfigRow
                key={field.key}
                field={field}
                value={values[field.key] ?? ""}
                onChange={(v) => setValues({ ...values, [field.key]: v })}
              />
            ))
          )}
          {mutation.error instanceof Error && (
            <div className="text-sm pt-2" style={{ color: "var(--state-error)" }}>
              {mutation.error.message}
            </div>
          )}
        </div>
      </Panel>
    </form>
  );
}

function ConfigRow({ field, value, onChange }: { field: ConfigMeta; value: string; onChange: (next: string) => void }) {
  const def = String(SYSTEM_CONFIG_DEFAULTS[field.key as keyof typeof SYSTEM_CONFIG_DEFAULTS] ?? "—");
  return (
    <div
      className="grid items-start gap-5"
      style={{
        gridTemplateColumns: "1fr 180px",
        padding: "14px 0",
        borderTop: "1px solid var(--border-faint)",
      }}
    >
      <div>
        <div className="flex items-baseline gap-2">
          <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--fg)" }}>{field.label}</span>
          <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-4)" }}>
            {field.key}
          </span>
        </div>
        <div style={{ fontSize: 11, color: "var(--fg-3)", marginTop: 2 }}>{field.description}</div>
        <UppercaseLabel style={{ marginTop: 4, display: "block" }}>
          default{" "}
          <span className="mono" style={{ color: "var(--fg-3)", textTransform: "none", letterSpacing: 0 }}>
            {def}
          </span>
        </UppercaseLabel>
      </div>
      <div style={{ position: "relative" }}>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full outline-none mono"
          style={{
            padding: `5px ${field.unit ? 56 : 10}px 5px 10px`,
            fontSize: 12,
            background: "var(--bg-sunken)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            color: "var(--fg)",
          }}
        />
        {field.unit && (
          <span
            className="mono"
            style={{
              position: "absolute",
              right: 8,
              top: "50%",
              transform: "translateY(-50%)",
              fontSize: 10,
              color: "var(--fg-4)",
              pointerEvents: "none",
            }}
          >
            {field.unit}
          </span>
        )}
      </div>
    </div>
  );
}
