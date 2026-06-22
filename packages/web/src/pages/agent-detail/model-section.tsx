import type { RuntimeProvider } from "@first-tree/shared";
import { useMemo } from "react";
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
 * Codex CLI model slugs baked into `@openai/codex@0.125.0` — extracted from
 * the bundled binary's config schema. ChatGPT-account auth restricts which
 * are usable at runtime (gpt-5.5 works; older slugs reject); API-key auth
 * accepts the wider set. The picker lists all and lets the runtime surface
 * actual permission errors instead of pre-validating per auth mode.
 */
export const CODEX_MODEL_OPTIONS: ModelOption[] = [
  { value: "gpt-5.5", label: "gpt-5.5", hint: "latest" },
  { value: "gpt-5.4", label: "gpt-5.4" },
  { value: "gpt-5.4-mini", label: "gpt-5.4-mini", hint: "fastest" },
  { value: "gpt-5.3-codex", label: "gpt-5.3-codex", hint: "coding-specialized" },
  { value: "gpt-5.2", label: "gpt-5.2" },
];

const MODEL_OPTIONS_BY_PROVIDER: Record<RuntimeProvider, ModelOption[]> = {
  "claude-code": CLAUDE_MODEL_OPTIONS,
  "claude-code-tui": CLAUDE_MODEL_OPTIONS,
  codex: CODEX_MODEL_OPTIONS,
};

const MODEL_HELP_BY_PROVIDER: Record<RuntimeProvider, string> = {
  "claude-code": "Applies to new sessions immediately. Unset falls back to the CLI default.",
  "claude-code-tui": "Applies to new sessions immediately. Model swap restarts the tmux session (~2–4s).",
  codex: "Applies to new sessions immediately. Unset lets the CLI pick by auth mode.",
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

  return (
    <ConfigRow label="Model" helpText={MODEL_HELP_BY_PROVIDER[provider]}>
      <Select options={items} value={value} onChange={onChange} disabled={disabled} mono aria-label="Model" />
    </ConfigRow>
  );
}
