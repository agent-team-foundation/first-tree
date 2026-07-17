import type { ProviderModelCatalog, RuntimeProvider } from "@first-tree/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { getProviderModels } from "../../api/activity.js";
import { Input } from "../../components/ui/input.js";
import { Select, type SelectOption } from "../../components/ui/select.js";
import { ConfigRow } from "./flat-section.js";

/**
 * Model — an inline dropdown. Selecting a value saves it immediately (onChange),
 * consistent with every other control on the page; there is no draft / Save Bar.
 *
 * Phase 1 host-local catalogs (Cursor / Kimi): options come from the bound
 * computer's real provider. Fallbacks required by product:
 *   1. DEFAULT (empty string) — inherit the provider's local default config
 *   2. Custom — free-form exact model id the operator types
 */

export type ModelOption = SelectOption;

export const CLAUDE_MODEL_OPTIONS: ModelOption[] = [
  // Full id rather than the `fable` alias: older Claude Code builds don't know
  // the alias, but pass unknown full ids through to the API, where
  // `claude-fable-5` resolves natively.
  { value: "claude-fable-5", label: "fable", hint: "most powerful" },
  { value: "opus", label: "opus", hint: "most capable" },
  { value: "sonnet", label: "sonnet", hint: "balanced" },
  { value: "haiku", label: "haiku", hint: "fastest" },
];

/**
 * Curated Codex model ids exposed by the picker. Keep this as an enum-style
 * `as const` object (rather than a TypeScript enum) so option values stay
 * literal-typed and easy to reuse in Zod-compatible code. Runtime config still
 * accepts arbitrary strings: account access differs and newer model ids must
 * remain usable before this picker is refreshed.
 */
export const CODEX_MODEL_IDS = {
  GPT_5_6_SOL: "gpt-5.6-sol",
  GPT_5_6_TERRA: "gpt-5.6-terra",
  GPT_5_6_LUNA: "gpt-5.6-luna",
  GPT_5_5: "gpt-5.5",
  GPT_5_4: "gpt-5.4",
  GPT_5_4_MINI: "gpt-5.4-mini",
  GPT_5_3_CODEX: "gpt-5.3-codex",
  GPT_5_2: "gpt-5.2",
} as const;

export type CodexModelId = (typeof CODEX_MODEL_IDS)[keyof typeof CODEX_MODEL_IDS];

export const CODEX_MODEL_OPTIONS: Array<ModelOption & { value: CodexModelId }> = [
  { value: CODEX_MODEL_IDS.GPT_5_6_SOL, label: CODEX_MODEL_IDS.GPT_5_6_SOL, hint: "flagship" },
  { value: CODEX_MODEL_IDS.GPT_5_6_TERRA, label: CODEX_MODEL_IDS.GPT_5_6_TERRA, hint: "balanced" },
  { value: CODEX_MODEL_IDS.GPT_5_6_LUNA, label: CODEX_MODEL_IDS.GPT_5_6_LUNA, hint: "fastest" },
  { value: CODEX_MODEL_IDS.GPT_5_5, label: CODEX_MODEL_IDS.GPT_5_5 },
  { value: CODEX_MODEL_IDS.GPT_5_4, label: CODEX_MODEL_IDS.GPT_5_4 },
  { value: CODEX_MODEL_IDS.GPT_5_4_MINI, label: CODEX_MODEL_IDS.GPT_5_4_MINI },
  {
    value: CODEX_MODEL_IDS.GPT_5_3_CODEX,
    label: CODEX_MODEL_IDS.GPT_5_3_CODEX,
    hint: "coding-specialized",
  },
  { value: CODEX_MODEL_IDS.GPT_5_2, label: CODEX_MODEL_IDS.GPT_5_2 },
];

/** Sentinel Select value for the custom free-form path — never written to config. */
export const CUSTOM_MODEL_SENTINEL = "__custom__";

const HOST_LOCAL_MODEL_PROVIDERS: ReadonlySet<RuntimeProvider> = new Set(["cursor", "kimi-code"]);

const CURATED_OPTIONS_BY_PROVIDER: Partial<Record<RuntimeProvider, ModelOption[]>> = {
  "claude-code": CLAUDE_MODEL_OPTIONS,
  "claude-code-tui": CLAUDE_MODEL_OPTIONS,
  codex: CODEX_MODEL_OPTIONS,
};

const MODEL_HELP_BY_PROVIDER: Record<RuntimeProvider, string> = {
  "claude-code": "Applies to new sessions immediately. Unset falls back to the CLI default.",
  "claude-code-tui": "Applies to new sessions immediately. Model swap restarts the tmux session (~2–4s).",
  codex: "Applies to new sessions immediately. Unset lets the CLI pick by auth mode.",
  cursor:
    "Pick a model from this computer's Cursor account catalog, leave DEFAULT to inherit Cursor's local default (auto), or enter a custom exact model id. An id your account can't use fails visibly — no silent fallback.",
  "kimi-code":
    "Pick a model from this computer's ~/.kimi-code config, leave DEFAULT to inherit the local default_model, or enter a custom exact model id.",
};

export type ModelSectionProps = {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  /** Runtime this agent runs on — drives the option list and help copy. */
  provider?: RuntimeProvider;
  /** Bound computer id — required to fetch host-local catalogs (Cursor / Kimi). */
  clientId?: string | null;
};

const DEFAULT_OPTION: ModelOption = { value: "", label: "DEFAULT", hint: "inherit local" };

export function ModelSection({
  value,
  onChange,
  disabled,
  provider = "claude-code",
  clientId = null,
}: ModelSectionProps) {
  const usesHostCatalog = HOST_LOCAL_MODEL_PROVIDERS.has(provider);
  const presetOptions = CURATED_OPTIONS_BY_PROVIDER[provider] ?? [];
  const curatedItems = useMemo<ModelOption[]>(() => {
    const list: ModelOption[] = [DEFAULT_OPTION, ...presetOptions];
    if (value !== "" && !presetOptions.some((o) => o.value === value)) {
      list.push({ value, label: value, hint: "custom" });
    }
    return list;
  }, [presetOptions, value]);

  if (usesHostCatalog) {
    return (
      <ConfigRow label="Model" helpText={MODEL_HELP_BY_PROVIDER[provider]}>
        <HostLocalModelPicker
          value={value}
          onChange={onChange}
          disabled={disabled}
          provider={provider}
          clientId={clientId}
        />
      </ConfigRow>
    );
  }

  return (
    <ConfigRow label="Model" helpText={MODEL_HELP_BY_PROVIDER[provider]}>
      <Select options={curatedItems} value={value} onChange={onChange} disabled={disabled} mono aria-label="Model" />
    </ConfigRow>
  );
}

function HostLocalModelPicker({
  value,
  onChange,
  disabled,
  provider,
  clientId,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  provider: RuntimeProvider;
  clientId: string | null;
}) {
  const [catalog, setCatalog] = useState<ProviderModelCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [customMode, setCustomMode] = useState(false);

  useEffect(() => {
    if (!clientId) {
      setCatalog(null);
      setLoadError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void getProviderModels(clientId, provider)
      .then((next) => {
        if (cancelled) return;
        setCatalog(next);
        if (next.source === "unavailable") {
          setLoadError(next.error ?? "Could not load models from this computer");
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setCatalog(null);
        setLoadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, provider]);

  const catalogOptions = useMemo<ModelOption[]>(() => {
    if (!catalog || catalog.source === "unavailable") return [];
    return catalog.models.map((m) => ({
      value: m.id,
      label: m.label ?? m.id,
      hint: m.hint,
    }));
  }, [catalog]);

  const valueInCatalog = value !== "" && catalogOptions.some((o) => o.value === value);
  const showCustomInput = customMode || (value !== "" && !valueInCatalog);

  useEffect(() => {
    if (value !== "" && !valueInCatalog && catalogOptions.length > 0) {
      setCustomMode(true);
    }
    if (value === "") setCustomMode(false);
  }, [value, valueInCatalog, catalogOptions.length]);

  const selectValue = showCustomInput ? CUSTOM_MODEL_SENTINEL : value;

  const items = useMemo<ModelOption[]>(() => {
    const list: ModelOption[] = [DEFAULT_OPTION, ...catalogOptions];
    list.push({ value: CUSTOM_MODEL_SENTINEL, label: "Custom…", hint: "type exact id" });
    if (value !== "" && !catalogOptions.some((o) => o.value === value) && value !== CUSTOM_MODEL_SENTINEL) {
      // Keep the current custom id visible in the list while editing.
      list.splice(list.length - 1, 0, { value, label: value, hint: "custom" });
    }
    return list;
  }, [catalogOptions, value]);

  const onSelectChange = (next: string) => {
    if (next === CUSTOM_MODEL_SENTINEL) {
      setCustomMode(true);
      return;
    }
    setCustomMode(false);
    onChange(next);
  };

  // No computer bound / catalog unavailable → free-form with DEFAULT empty via clearing.
  if (!clientId || (catalog?.source === "unavailable" && catalogOptions.length === 0 && !loading)) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
        <Select
          options={[DEFAULT_OPTION, ...(value ? [{ value, label: value, hint: "custom" }] : [])]}
          value={value === "" || !value ? "" : value}
          onChange={onChange}
          disabled={disabled}
          mono
          aria-label="Model"
        />
        <FreeFormModelInput
          value={value}
          onChange={onChange}
          disabled={disabled}
          provider={provider}
          placeholder={provider === "kimi-code" ? "custom model id (or leave DEFAULT above)" : "custom model id"}
        />
        {loadError ? (
          <p className="text-caption" style={{ color: "var(--fg-3)", margin: 0 }}>
            {clientId ? `Catalog unavailable: ${loadError}. You can still set DEFAULT or type a custom id.` : null}
            {!clientId ? "Bind a computer to load its model catalog. DEFAULT and custom id still work." : null}
          </p>
        ) : !clientId ? (
          <p className="text-caption" style={{ color: "var(--fg-3)", margin: 0 }}>
            Bind a computer to load its model catalog. DEFAULT inherits the local provider default; custom id is always
            available.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
      <Select
        options={items}
        value={selectValue}
        onChange={onSelectChange}
        disabled={disabled || loading}
        searchable={catalogOptions.length > 8}
        mono
        aria-label="Model"
        placeholder={loading ? "Loading models…" : undefined}
      />
      {showCustomInput ? (
        <FreeFormModelInput
          value={value}
          onChange={onChange}
          disabled={disabled}
          provider={provider}
          placeholder={provider === "kimi-code" ? "exact Kimi model id" : "exact Cursor model id"}
        />
      ) : null}
      {loadError && catalogOptions.length > 0 ? (
        <p className="text-caption" style={{ color: "var(--fg-3)", margin: 0 }}>
          Catalog warning: {loadError}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Free-form exact-model input. Commits on blur / Enter rather than per
 * keystroke — every other control on this page saves on change, but a text
 * field saving each character would spam config writes.
 */
function FreeFormModelInput({
  value,
  onChange,
  disabled,
  provider,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  provider: RuntimeProvider;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value);
  // Latch scoped to ONE Enter→blur sequence: Enter followed by the immediate
  // blur must not fire a second identical save while the first round-trip is
  // still in flight (the `value` prop only advances after the save lands, and
  // a duplicate write would carry a stale expectedVersion → spurious
  // conflict). The latch expires on refocus (and on a value round-trip), so a
  // FAILED save stays retryable with the same intended model — the user
  // clicks back in and presses Enter again.
  const lastSentRef = useRef<string | null>(null);
  useEffect(() => {
    setDraft(value);
    lastSentRef.current = null;
  }, [value]);
  const commit = () => {
    const next = draft.trim();
    if (next !== value && next !== lastSentRef.current) {
      lastSentRef.current = next;
      onChange(next);
    }
  };
  return (
    <Input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => {
        lastSentRef.current = null;
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
      disabled={disabled}
      placeholder={placeholder ?? (provider === "kimi-code" ? "local Kimi default" : "auto (Cursor default)")}
      className="font-mono"
      aria-label="Custom model id"
    />
  );
}
