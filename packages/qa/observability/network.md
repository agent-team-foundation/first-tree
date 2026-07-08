# Network Evidence

Network evidence can include HTTP request/response summaries, API probe output, browser network observations, access
logs, HAR files, proxy logs, or tunnel state.

Capture network evidence when it is needed to support the QA conclusion. Do not make full network tracing the default
for every run.

External access must be explicit in the QA plan. Do not expose internal databases, artifacts, provider homes, runtime
homes, or host credential stores.
