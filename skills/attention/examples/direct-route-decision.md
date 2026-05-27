# Direct — route a decision that's not your call

A request-style NHA used when the agent has discovered a fork in the road that **belongs to the human** (product trade-off, customer-facing tone, legal ambiguity, who-owns-what). The agent is **not** asking permission to do something it can do; it's reporting that the decision itself is out of scope.

## CLI

```bash
first-tree attention raise \
  --chat support-q4 \
  --target yuezengwu \
  --subject "Customer demands full refund + apology letter — over my limit, your call" \
  --body @body.md \
  --requires-response \
  --meta 'tags[0]=direct' \
  --meta 'tags[1]=customer-escalation' \
  --meta 'timeoutHint=2h' \
  --meta 'validityScope=this ticket only' \
  --meta-json @options.json
```

## body.md

```markdown
## Question
TICKET-8821 (VIP customer) wants: (a) full refund $4,200, (b) a CTO-signed apology letter, (c) a public root-cause post. My handling cap is $500 + a template apology — the other two need your call.

## Background
- Root cause is last Wednesday's prod DB failover (fixed; post-mortem at incident-2026-05-21.md)
- Customer impact: 3 orders delayed 90 min (auto-refunded) + 1 mis-ordered item (manual refund)
- Customer's screenshots are in the chat (see the previous message I sent)
- Legal teammate @baixiaohang is offline; his prior stance on "public root-cause posts" has been cautious

## What I'll do
- You reply "approve-full": I execute all three
- You reply "partial": tell me in the free-form reply which subset to do
- You reply "escalate-legal": I close this NHA, hand off to baixiaohang, and raise a fresh NHA once he's online

## Validity scope
TICKET-8821 only. Not "treat all future complaints this way".
```

## options.json

```json
{
  "options": {
    "mode": "single",
    "items": [
      { "value": "approve-full",   "label": "Do all three" },
      { "value": "partial",        "label": "Partial (specify in free-form reply)" },
      { "value": "escalate-legal", "label": "Hand off to baixiaohang, wait for legal" }
    ]
  },
  "fallback": "escalate-legal",
  "validityScope": "TICKET-8821 only"
}
```

## Notes

- The key to "Direct" is naming the **type of decision**: what you can do versus what's over your authority. Don't pretend to be asking advice when you're actually asking for permission.
- `escalate` is a legitimate option, but spell out the follow-up path in the body. Don't let "escalate" mean "I'm dropping this on you" — be explicit about closing this NHA and how legal gets the handoff.
- Money, personnel, legal, and customer-facing public commitments almost always belong here — not in endorse or supply.
- `timeoutHint` is for the human, not a system fallback. For genuinely urgent escalations, pair it with a normal chat @mention to nudge.
