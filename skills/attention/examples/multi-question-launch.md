# Multi-question — bundle related decisions into one NHA

When you have several **related** decisions all blocked on the same human, raise **one** NHA with `metadata.questions[]` instead of several parallel NHAs. The human answers all questions atomically (the UI submits them together); skip-rate stays low because the human sees the full picture at once.

Use sparingly. Rule of thumb: questions belong together iff (a) they're answered in the same head-state and (b) deferring some while acting on others is incoherent.

## CLI

```bash
first-tree attention raise \
  --chat product-launch-q3 \
  --target yuezengwu \
  --subject "Launching checkout v2 next Monday — 3 launch parameters I can't decide alone" \
  --body @body.md \
  --requires-response \
  --meta 'tags[0]=launch-decision' \
  --meta 'timeoutHint=24h' \
  --meta-json @questions.json
```

## body.md

```markdown
## Question
checkout v2 is ready for Monday. Regression is green, but 3 settings need your call:

1. **Rollout pacing** (10% gradual vs 100% all at once)
2. **Auto-rollback threshold** (how much p95-latency increase triggers a revert)
3. **Customer comms timing** (announce before launch vs after)

Each question lists options and my recommended default; pick one per question, or jump to free-form once at the end if you want to write it out.
```

## questions.json

```json
{
  "questions": [
    {
      "id": "rollout-pace",
      "prompt": "Rollout pacing",
      "context": "The previous comparable change used a 24h gradual ramp (10/50/100). Regression has been more thorough this time.",
      "options": {
        "mode": "single",
        "defaultValue": "gradual",
        "items": [
          { "value": "gradual",  "label": "10/50/100 gradual ramp (24h)" },
          { "value": "fast",     "label": "10/100 two-step (4h)" },
          { "value": "full",     "label": "Straight to 100% (no ramp)" }
        ]
      }
    },
    {
      "id": "rollback-threshold",
      "prompt": "Auto-rollback threshold (p95 latency delta)",
      "options": {
        "mode": "single",
        "defaultValue": "p50",
        "items": [
          { "value": "p20", "label": "+20% triggers rollback" },
          { "value": "p50", "label": "+50% triggers rollback (default)" },
          { "value": "off", "label": "No auto-rollback this time, eyes on" }
        ]
      }
    },
    {
      "id": "announce",
      "prompt": "Customer comms timing",
      "options": {
        "mode": "single",
        "items": [
          { "value": "before", "label": "Announce before launch ('heads-up')" },
          { "value": "after",  "label": "Announce after launch ('it's live')" },
          { "value": "skip",   "label": "Skip — roll into the weekly digest" }
        ]
      }
    }
  ],
  "fallback": "gradual + p50 + announce after — escalate to @baixiaohang if no reply in 24h",
  "validityScope": "this single launch window only"
}
```

## Notes

- Submission is **atomic**: the UI will not let the human submit until every question is answered. If you want answers to land one at a time, split into separate sequential NHAs (close one, then raise the next) and accept that the human may lose interest mid-way.
- `questions[*].id` is the key in the returned `answers` object. Your handler reads `answers["rollout-pace"]` / `answers["rollback-threshold"]` / `answers["announce"]` before acting.
- Don't let `questions[]` grow past one screen — the visual cost makes humans abandon. If you need more than 5, the task probably isn't sliced finely enough.
- Don't mix "decisions" and "missing facts" in one multi-question. The mental modes are different; humans get confused about whether they're picking or filling in.
- Write `fallback` once for the whole NHA, not per question — the human shouldn't have to negotiate three timeouts.
