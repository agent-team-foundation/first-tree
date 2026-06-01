import type { RuntimeProvider } from "@first-tree/shared";
import { useMemo } from "react";
import { Button } from "../../components/ui/button.js";
import { DraftStatusChip } from "../../components/ui/draft-status-chip.js";
import { Select, type SelectOption } from "../../components/ui/select.js";
import { ConfigRow } from "./flat-section.js";

/**
 * Reasoning effort — an inline dropdown mirroring the Model row. Options and
 * help copy are provider-specific (no abstraction over the providers):
 *   - claude-code maps to the SDK `effort` (low/medium/high/max), plus an
 *     "" inherit option that defers to the operator's local effortLevel.
 *   - codex maps to `modelReasoningEffort` (low/medium/high/xhigh); "minimal"
 *     is excluded because it breaks the default tool set.
 */

const CLAUDE_EFFORT_OPTIONS: SelectOption[] = [
  { value: "", label: "(unset — inherits local)" },
  { value: "low", label: "low", hint: "fastest" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high", hint: "default" },
  { value: "max", label: "max", hint: "Opus only" },
];

const CODEX_EFFORT_OPTIONS: SelectOption[] = [
  { value: "low", label: "low", hint: "fastest" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high", hint: "default" },
  { value: "xhigh", label: "xhigh", hint: "most" },
];

const EFFORT_OPTIONS_BY_PROVIDER: Record<RuntimeProvider, SelectOption[]> = {
  "claude-code": CLAUDE_EFFORT_OPTIONS,
  // claude-code-tui drives the same `claude` CLI as claude-code, so it shares
  // the identical effort options + inherit sentinel.
  "claude-code-tui": CLAUDE_EFFORT_OPTIONS,
  codex: CODEX_EFFORT_OPTIONS,
};

const EFFORT_HELP_BY_PROVIDER: Record<RuntimeProvider, string> = {
  "claude-code": "Applies to new sessions. Unset inherits the local ~/.claude effortLevel; setting it overrides.",
  "claude-code-tui": "Applies to new sessions. Unset inherits the local ~/.claude effortLevel; setting it overrides.",
  codex: "Applies to new sessions. Higher means more reasoning per turn.",
};

export type ReasoningEffortSectionProps = {
  value: string;
  baseline: string;
  onChange: (v: string) => void;
  onRevert: () => void;
  disabled?: boolean;
  /** Runtime this agent runs on — drives the option list and help copy. */
  provider?: RuntimeProvider;
};

export function ReasoningEffortSection({
  value,
  baseline,
  onChange,
  onRevert,
  disabled,
  provider = "claude-code",
}: ReasoningEffortSectionProps) {
  const dirty = value !== baseline;
  const presetOptions = EFFORT_OPTIONS_BY_PROVIDER[provider];

  const items = useMemo<SelectOption[]>(() => {
    // Surface an unrecognized stored value (e.g. after a provider rebind) so
    // the dropdown still shows the current selection instead of silently
    // snapping to the first option.
    if (value !== "" && !presetOptions.some((o) => o.value === value)) {
      return [...presetOptions, { value, label: value, hint: "custom" }];
    }
    return presetOptions;
  }, [presetOptions, value]);

  return (
    <ConfigRow
      label="Reasoning effort"
      helpText={EFFORT_HELP_BY_PROVIDER[provider]}
      meta={dirty ? <DraftStatusChip status="modified" /> : null}
      action={
        dirty ? (
          <Button size="xs" variant="ghost" onClick={onRevert} disabled={disabled}>
            Revert
          </Button>
        ) : null
      }
    >
      <Select
        options={items}
        value={value}
        onChange={onChange}
        disabled={disabled}
        placeholder="(unset)"
        aria-label="Reasoning effort"
      />
    </ConfigRow>
  );
}
