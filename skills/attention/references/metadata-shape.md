# `metadata.options` and `metadata.questions` — shape reference

The canonical shapes are defined in `packages/shared/src/schemas/attention.ts`. Everything below mirrors that file. The metadata bag uses `.catchall(z.unknown())` so the server will not reject unknown keys — but the keys below are the conventional ones the UI knows how to render.

## Single decision: `metadata.options`

Use when the NHA asks one question and the human picks from a fixed set.

```ts
type AttentionOptionItem = {
  value: string;            // machine-friendly id; goes into `answers` on respond
  label: string;            // human-readable button text
  hint?: string;            // optional one-line subtitle below the label
  input?: {                 // ask for typed input alongside the choice
    type: "text" | "number" | "datetime";
    required?: boolean;
    placeholder?: string;
  };
};

type AttentionOptionGroup = {
  mode: "single" | "multi";
  min?: number;             // multi only
  max?: number;             // multi only
  defaultValue?: string | string[]; // pre-selected; UI may render as one-click
  items: AttentionOptionItem[];     // at least 1
};
```

Example — single choice with a default:

```json
{
  "options": {
    "mode": "single",
    "defaultValue": "deploy",
    "items": [
      { "value": "deploy",   "label": "批准 deploy 到 prod" },
      { "value": "postpone", "label": "推迟到下个 deploy 窗口" },
      { "value": "abandon",  "label": "放弃这次 deploy" }
    ]
  }
}
```

Example — multi with bounds:

```json
{
  "options": {
    "mode": "multi",
    "min": 1,
    "max": 3,
    "items": [
      { "value": "rerun-tests",       "label": "重跑测试" },
      { "value": "rebuild-image",     "label": "重新构建镜像" },
      { "value": "notify-oncall",     "label": "通知 oncall" },
      { "value": "open-incident",     "label": "开 incident ticket" }
    ]
  }
}
```

Example — option with typed input:

```json
{
  "options": {
    "mode": "single",
    "items": [
      { "value": "approve",        "label": "批准" },
      { "value": "approve-window", "label": "批准，但指定 deploy 时间",
        "input": { "type": "datetime", "required": true,
                   "placeholder": "e.g. 2026-05-27 09:00" } },
      { "value": "reject",         "label": "拒绝" }
    ]
  }
}
```

## Multiple decisions in one NHA: `metadata.questions`

Use when several related questions should be answered together. The whole NHA is submitted atomically (the human must answer all questions before submit). M1 末 the UI renders a single top-level question; full multi-question rendering lands in M2 初. Populate `questions[]` now if you have it — the data is preserved and surfaced as soon as the UI catches up.

```ts
type AttentionQuestion = {
  id: string;               // stable id; goes into `answers` keys on respond
  prompt: string;           // sub-question text
  context?: string;         // optional background specific to this sub-question
  options?: AttentionOptionGroup;
};
```

Example:

```json
{
  "questions": [
    {
      "id": "deploy_decision",
      "prompt": "要不要 deploy commit abc123？",
      "options": {
        "mode": "single",
        "items": [
          { "value": "yes", "label": "yes, deploy" },
          { "value": "no",  "label": "no, hold" }
        ]
      }
    },
    {
      "id": "deploy_window",
      "prompt": "如果 deploy，什么时候？",
      "context": "下一个标准窗口是今晚 22:00。",
      "options": {
        "mode": "single",
        "items": [
          { "value": "now",     "label": "立刻" },
          { "value": "window",  "label": "等今晚 22:00 窗口" }
        ]
      }
    }
  ]
}
```

When the human responds via the structured path, the `answers` map is keyed by question `id` (or `"default"` for a single-question NHA whose options live under `metadata.options`):

```json
{
  "answers": {
    "deploy_decision": "yes",
    "deploy_window":   "window"
  }
}
```

## Other conventional metadata keys

Free-form, but the UI may surface them as labelled chips:

- `tags: string[]` — e.g. `["endorse", "deploy"]`. Pass via indexed slots (`--meta tags[0]=endorse --meta tags[1]=deploy`) or in `--meta-json`.
- `timeoutHint: string` — free-form, e.g. `"4h"`. Not enforced by the system.
- `validityScope: string` — free-form, e.g. `"single commit hash abc123"`.
- `fallback: string` — free-form, what the agent will do on no-response.

## Constraints to respect

- **Atomic submission for multi-question.** All questions answered, or none. If you want partial-submit semantics, split into multiple serial NHAs.
- **Timeout is whole-NHA.** Any single question expiring means the entire NHA is considered unanswered. Plan your `metadata.fallback` accordingly.
- **Server does not validate `answers` shape.** It stores whatever object the human's client posted, so the convention can evolve here without a schema bump. Be defensive when reading responses: tolerate missing keys and extra keys.
- **At most one open request-NHA per chat.** UI assumption — agents must self-enforce. If you need a follow-up, cancel + raise.
