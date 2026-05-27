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
      { "value": "deploy",   "label": "Approve deploy to prod" },
      { "value": "postpone", "label": "Postpone to next deploy window" },
      { "value": "abandon",  "label": "Drop this deploy" }
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
      { "value": "rerun-tests",       "label": "Re-run tests" },
      { "value": "rebuild-image",     "label": "Rebuild image" },
      { "value": "notify-oncall",     "label": "Notify oncall" },
      { "value": "open-incident",     "label": "Open incident ticket" }
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
      { "value": "approve",        "label": "Approve" },
      { "value": "approve-window", "label": "Approve, but specify the deploy time",
        "input": { "type": "datetime", "required": true,
                   "placeholder": "e.g. 2026-05-27 09:00" } },
      { "value": "reject",         "label": "Reject" }
    ]
  }
}
```

## Multiple decisions in one NHA: `metadata.questions`

Use when several related questions should be answered together. The whole NHA is submitted atomically (the human must answer all questions before submit). The UI renders every question; populate `questions[]` whenever you have multiple related sub-decisions for the same human.

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
      "prompt": "Should we deploy commit abc123?",
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
      "prompt": "If yes, when?",
      "context": "Next standard window is tonight at 22:00.",
      "options": {
        "mode": "single",
        "items": [
          { "value": "now",     "label": "Now" },
          { "value": "window",  "label": "Wait for tonight's 22:00 window" }
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

## Attachments (planned convention, not yet rendered)

Attention deliberately does NOT couple to `messages` for content (see the design note in `SKILL.md`'s "Attention vs Chat message" section). Inline images and file attachments are not in the schema today; the planned shape lives on `metadata.attachments` as part of the extensible bag:

```json
{
  "attachments": [
    { "kind": "image", "url": "https://...", "alt": "p95 latency spike" },
    { "kind": "file",  "url": "https://...", "name": "deploy-plan.pdf", "mime": "application/pdf" }
  ]
}
```

Until the UI renders these, the pragmatic workaround is: post a normal chat message with the image (messages already handle attachments), then raise the attention with the body referencing the message id in prose. Don't tile up `metadata` with raw base64 — the bag is for refs, not blobs.

## Constraints to respect

- **Atomic submission for multi-question.** All questions answered, or none. If you want partial-submit semantics, split into multiple serial NHAs.
- **Timeout is whole-NHA.** Any single question expiring means the entire NHA is considered unanswered. Plan your `metadata.fallback` accordingly.
- **Server does not validate `answers` shape.** It stores whatever object the human's client posted, so the convention can evolve here without a schema bump. Be defensive when reading responses: tolerate missing keys and extra keys.
- **At most one open request-NHA per chat.** UI assumption — agents must self-enforce. If you need a follow-up, cancel + raise.
