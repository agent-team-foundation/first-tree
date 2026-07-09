# Evidence Guidance

Evidence is chosen per task. No single evidence type is mandatory for every run, but every formal conclusion must point
to evidence that actually supports it.

## Evidence Menu

- Command output for CLI behavior, setup checks, build steps, or provider smoke checks.
- Service logs for server, web, daemon, runtime, Docker, or startup failures.
- HTTP/API probes for API behavior, auth, persistence, or integration boundaries.
- Database observations for persistence, permissions, state transitions, and fixture setup.
- Screenshots, browser console output, and browser network observations for UI behavior.
- Runtime transcripts or provider logs for real agent-turn behavior.

## Use Judgment

Use the least evidence that makes the conclusion credible. A CLI-only run does not need screenshots. A UI regression may
need browser evidence. A persistence bug may need API and database observations. Direct database fixture setup can prove a
precondition, but it is not product behavior evidence.

## Redaction

Avoid pasting secrets into reports. Redact tokens, cookies, authorization headers, provider credentials, private
connection strings, personal data, and private session content. When evidence is sensitive, summarize the observation and
keep the local artifact path available for the operator.
