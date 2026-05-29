# Security Policy

## Supported Versions

Security fixes are prioritized for:

- the latest `main` branch in this repository
- the latest published `first-tree` CLI package

Older snapshots may receive best-effort guidance, but they should not be
assumed to get backported fixes.

## Reporting a Vulnerability

First Tree includes authentication, JWT handling, agent runtime, GitHub
App/webhook, and local daemon surfaces. Please report suspected vulnerabilities
privately.

Preferred path:

1. Use GitHub Private Vulnerability Reporting for this repository if that
   option is available in the Security tab.

Fallback path:

1. Email the report to `security@first-tree.ai`.
2. Do not open public GitHub issues, discussions, PR comments, or other public
   summaries for suspected vulnerabilities. Even high-level summaries may expose
   exploitable details.
3. If you need encrypted or otherwise private follow-up, request it by email and
   maintainers will arrange an appropriate handoff.

## What To Include

Helpful private reports usually include:

- affected command or package surface
- impacted version or commit
- prerequisites and expected impact
- reproduction notes suitable for maintainer validation in a private channel
- suggested remediation or patch direction, if you have one

## Response Expectations

Maintainers will acknowledge or otherwise respond within 3 calendar days. The
initial response may confirm receipt, ask for additional private details, or
begin impact triage; it is not a guarantee of full remediation within that
window.

Maintainers will try to confirm the report, understand the impact, and land a
fix or mitigation before requesting public disclosure details. Coordinated
disclosure is appreciated once a fix or mitigation is available.
