# Security Policy

## Supported Versions

Security fixes are prioritized for:

- the latest `main` branch in this repository
- the latest published `first-tree` CLI package

Older snapshots may receive best-effort guidance, but they should not be
assumed to get backported fixes.

## Reporting a Vulnerability

Please do not post exploit details in a public GitHub issue.

Preferred path:

1. Use GitHub Private Vulnerability Reporting for this repository if that
   option is available in the Security tab.

Fallback path:

1. Open a public issue with only the affected area and impact summary.
2. Do not include proof-of-concept code, secrets, or reproduction steps that
   would make the issue exploitable.
3. Ask the maintainers to provide a private handoff path for the full report.

## What To Include

Helpful reports usually include:

- affected command or package surface
- impacted version or commit
- prerequisites and expected impact
- reproduction notes that a maintainer can validate privately
- suggested remediation or patch direction, if you have one

## Response Expectations

Maintainers will try to confirm the report, understand the impact, and land a
fix before requesting public disclosure details. Coordinated disclosure is
appreciated once a fix or mitigation is available.
