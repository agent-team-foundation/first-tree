import type { RuntimeProvider } from "@first-tree/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "../../components/ui/input.js";
import { Select, type SelectOption } from "../../components/ui/select.js";
import { ConfigRow } from "./flat-section.js";

/**
 * Model — an inline dropdown. Selecting a value saves it immediately (onChange),
 * consistent with every other control on the page; there is no draft / Save Bar.
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

const MODEL_OPTIONS_BY_PROVIDER: Record<RuntimeProvider, ModelOption[]> = {
  "claude-code": CLAUDE_MODEL_OPTIONS,
  "claude-code-tui": CLAUDE_MODEL_OPTIONS,
  codex: CODEX_MODEL_OPTIONS,
  // Cursor deliberately has NO curated list: the account-dependent SKU catalog
  // is large and shifting, so the control is a free-form exact-id input (see
  // ModelSection) and First Tree does not maintain a model matrix.
  cursor: [],
};

const MODEL_HELP_BY_PROVIDER: Record<RuntimeProvider, string> = {
  "claude-code": "Applies to new sessions immediately. Unset falls back to the CLI default.",
  "claude-code-tui": "Applies to new sessions immediately. Model swap restarts the tmux session (~2–4s).",
  codex: "Applies to new sessions immediately. Unset lets the CLI pick by auth mode.",
  cursor:
    "Exact Cursor model id, passed through verbatim on the next turn. Leave empty for the Cursor default (auto). An id your account can't use fails visibly — no silent fallback.",
};

export type ModelSectionProps = {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  /** Runtime this agent runs on — drives the option list and help copy. */
  provider?: RuntimeProvider;
};

const UNSET_OPTION: ModelOption = { value: "", label: "(unset — inherits local)" };

export function ModelSection({ value, onChange, disabled, provider = "claude-code" }: ModelSectionProps) {
  const presetOptions = MODEL_OPTIONS_BY_PROVIDER[provider];

  const items = useMemo<ModelOption[]>(() => {
    const list: ModelOption[] = [UNSET_OPTION, ...presetOptions];
    if (value !== "" && !presetOptions.some((o) => o.value === value)) {
      list.push({ value, label: value, hint: "custom" });
    }
    return list;
  }, [presetOptions, value]);

  if (provider === "cursor") {
    return (
      <ConfigRow label="Model" helpText={MODEL_HELP_BY_PROVIDER[provider]}>
        <FreeFormModelInput value={value} onChange={onChange} disabled={disabled} />
      </ConfigRow>
    );
  }

  return (
    <ConfigRow label="Model" helpText={MODEL_HELP_BY_PROVIDER[provider]}>
      <Select options={items} value={value} onChange={onChange} disabled={disabled} mono aria-label="Model" />
    </ConfigRow>
  );
}

/**
 * Free-form exact-model input (cursor). Commits on blur / Enter rather than
 * per keystroke — every other control on this page saves on change, but a
 * text field saving each character would spam config writes.
 */
function FreeFormModelInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  // Tracks the last value we sent, so Enter followed by an immediate blur
  // does not fire a second identical save while the first round-trip is still
  // in flight (the `value` prop only advances after the save lands, and a
  // duplicate write would carry a stale expectedVersion → spurious conflict).
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
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
      disabled={disabled}
      placeholder="auto (Cursor default)"
      className="font-mono"
      aria-label="Model"
    />
  );
}
