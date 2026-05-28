import type { RuntimeProvider } from "@first-tree/shared";
import { useMemo } from "react";
import { Button } from "../../components/ui/button.js";
import { ConfigRow } from "./flat-section.js";
import { ChangedChip, OptionDropdown, type SelectOption } from "./option-dropdown.js";

/**
 * Model — an inline dropdown with a "changed" hint and Revert. No inline save:
 * the page Save Bar handles submission.
 */

export type ModelOption = SelectOption;

export const CLAUDE_MODEL_OPTIONS: ModelOption[] = [
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
  codex: CODEX_MODEL_OPTIONS,
};

const MODEL_HELP_BY_PROVIDER: Record<RuntimeProvider, string> = {
  "claude-code": "Applies to new sessions immediately. Unset falls back to the CLI default.",
  codex: "Applies to new sessions immediately. Unset lets the CLI pick by auth mode.",
};

export type ModelSectionProps = {
  value: string;
  baseline: string;
  onChange: (v: string) => void;
  onRevert: () => void;
  disabled?: boolean;
  /** Runtime this agent runs on — drives the option list and help copy. */
  provider?: RuntimeProvider;
};

const UNSET_OPTION: ModelOption = { value: "", label: "(unset — inherits local)" };

export function ModelSection({
  value,
  baseline,
  onChange,
  onRevert,
  disabled,
  provider = "claude-code",
}: ModelSectionProps) {
  const dirty = value !== baseline;
  const presetOptions = MODEL_OPTIONS_BY_PROVIDER[provider];

  const items = useMemo<ModelOption[]>(() => {
    const list: ModelOption[] = [UNSET_OPTION, ...presetOptions];
    if (value !== "" && !presetOptions.some((o) => o.value === value)) {
      list.push({ value, label: value, hint: "custom" });
    }
    return list;
  }, [presetOptions, value]);

  return (
    <ConfigRow
      label="Model"
      helpText={MODEL_HELP_BY_PROVIDER[provider]}
      meta={dirty ? <ChangedChip /> : null}
      action={
        dirty ? (
          <Button size="xs" variant="ghost" onClick={onRevert} disabled={disabled}>
            Revert
          </Button>
        ) : null
      }
    >
      <OptionDropdown items={items} value={value} onChange={onChange} disabled={disabled} />
    </ConfigRow>
  );
}
