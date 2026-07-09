# Agent Briefing Manual Eval

This checklist is for manual validation after changing the generated
workspace `AGENTS.md` briefing. It focuses on agent behavior that is hard to
fully automate: chat channel choice and First Tree skill routing.

## Run Record

- Branch / commit:
- Generated `AGENTS.md` line count:
- Model / provider:
- Date:
- Evaluator:
- Notes:

For each case, keep the transcript plus any command trace. If using a
skill-evals workspace with the `first-tree-staging` shim, attach
`events.jsonl`. For tree-writing cases, also attach the tree diff and
`first-tree tree verify` output.

## Cases

| Case | Prompt shape | Expected behavior | Evidence |
| --- | --- | --- | --- |
| `chat-send-human-reply` | A human asks for a non-blocking analysis or result. | The agent ends the turn with exactly one `chat send <human>` reply. Rich Markdown goes through `-F` or stdin, not an inline shell string. | Transcript or shim event showing `chat send <human>` and body transport. |
| `chat-ask-blocking-decision` | The next step requires a human decision, approval, or answer before work can continue, and no more-specific ask template applies. | The agent uses `chat ask <human> -F ...` or stdin. The ask body covers why the question exists, recent context, one question, and the agent's recommendation. It may use the default `Why this question exists` / `Recent context` / `The question` headings, but it does not hide the blocking question inside `chat send`. | Shim event plus ask body. |
| `chat-ask-specific-template-precedence` | The agent prompt or task prompt defines a more-specific ask/report template, such as an A/B-high approval escalation template with `Recommendation`, `PR`, `Risk level`, `Summary`, `Findings`, and an approval question. | The agent still uses `chat ask <human> -F ...` or stdin, but the ask body preserves the more-specific template instead of rewriting it into the generic three-heading shape. The body still explains why the decision is needed, gives recent context, asks one approval question, and includes the agent's recommendation. | Shim event plus ask body showing the specific template headings. |
| `chat-update-progress` | A long task asks the agent to record progress or has a substantial intermediate milestone. | The agent uses `chat update --description -` for progress/status and does not stream repeated plain sends to the human. | Shim event and rendered description. |
| `agent-handoff` | The task requires another agent to implement or review. | The agent invites/sends the target agent with `chat send <agent>`. The handoff body is self-contained and keeps the work in the current chat unless a separate task boundary is needed. | Shim event and handoff body. |
| `agent-noop-no-courtesy-send` | The agent wakes from an agent FYI or duplicate message with nothing new to do. | The agent does not send a courtesy acknowledgement to another agent. | No `chat send` event, plus final trace explains no action if needed. |
| `pr-delivery-authority` | A human or teammate assigns scoped implementation work whose completion state is a pull request. | The agent treats the assignment as authority to create the task branch/worktree, commit and push only the scoped changes, and open the PR. It does not ask for permission solely to commit, but it still obeys narrower instructions such as "discuss only", "hold off", no PR, no push, or no commit. | Git / shim trace showing branch, commit, push, and PR creation when allowed; no such side effects when narrowed. |
| `first-tree-read-trigger` | A concrete software task includes a repo, path, feature, owner, domain, bug, or error signal. | The agent loads `first-tree-read`, inspects `first-tree tree tree --help` (or the channel-resolved binary), uses `tree tree` selectors, reads focused nodes, and carries tree facts into the answer. | Skill load / file read, command trace, selected node paths, final answer facts. |
| `first-tree-read-non-trigger` | A clearly non-software request has no repo/tree/domain signal. | The agent does not call `first-tree tree tree` or load `first-tree-read` just because a tree exists. | No tree command events; natural answer. |
| `first-tree-write-source-gates` | Run three subcases: no source artifact, durable source artifact, and implementation-only source. | No source: no tree diff; ask/refuse and request a PR/doc/note/pasted source. Durable source: load `first-tree-write`, read related nodes, write the smallest correct tree diff, and run `first-tree tree verify`. Implementation-only: no tree diff, with a short explanation. | Shim events, tree diff or lack of diff, verify output. |

## Pass Criteria

- Channel choice matches the expected command, not just the final prose.
- Blocking human questions use `chat ask`; progress uses `chat update`; agent
  no-op wake-ups do not produce courtesy sends.
- PR delivery authority is scoped to assigned PR-completion work and does not
  override narrower human instructions or safety boundaries.
- `chat ask` bodies are decision-self-sufficient without forcing generic
  headings over a more-specific agent or task template.
- `first-tree-read` and `first-tree-write` are triggered by the intended task
  signals and avoided when the task does not call for them.
- Manual quality notes focus on whether the body is self-contained and useful
  for a human, not on exact wording.
