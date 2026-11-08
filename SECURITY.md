# Security Policy

> ⚠️ SendGram is a **CUSTODIAL DEMO on TESTNET**. It has not been audited.
> No real funds are at risk. See [docs/LIMITATIONS.md](./docs/LIMITATIONS.md).

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Use one of the following channels:

1. **GitHub private vulnerability reporting** — open a [private security advisory](https://github.com/damiedee96/sendgram/security/advisories/new) on this repository (requires a GitHub account).

2. **Email** — send details to `mdeelive@gmail.com`.

Please include:
- A description of the vulnerability and the potential impact
- Steps to reproduce
- Any proof-of-concept code (if applicable)

We will acknowledge your report within 5 business days.

## Scope

Given that this is a testnet-only demo with no real funds:

| In scope | Out of scope |
|----------|-------------|
| Logic bugs that could drain testnet wallets | Anything requiring mainnet access |
| Cryptographic misuse (encryption, hashing) | Theoretical attacks with no practical path |
| Authentication/authorisation bypasses | UI/UX suggestions |
| Dependency vulnerabilities with a known exploit | Informational findings without impact |

## Known limitations

This demo has known architectural limitations that are not treated as vulnerabilities — they are documented in [docs/LIMITATIONS.md](./docs/LIMITATIONS.md). The most significant is that the bot operator holds a single encryption key that protects all wallets.
