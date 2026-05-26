# Security Policy

## Supported Versions

Security fixes are expected to apply to the latest released version of InboxPie.

## Reporting a Vulnerability

Please report security or privacy issues privately if possible. If a private security contact is not available yet, open a GitHub issue with minimal sensitive detail and ask for a private contact path.

Do not include real mailbox data, email addresses, message subjects, screenshots, or account identifiers in public reports.

## Security Expectations

InboxPie should:

- Process mailbox metadata locally
- Avoid remote code and telemetry
- Keep destructive or moving actions behind explicit review UI
- Request only permissions that are required for the product
- Escape untrusted mailbox metadata before rendering it as HTML

## Out of Scope

General Thunderbird behavior, provider-side email issues, and operating system compromise are outside the scope of this project unless InboxPie directly contributes to the issue.
