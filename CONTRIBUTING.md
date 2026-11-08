# Contributing to SendGram

> ⚠️ This is a CUSTODIAL DEMO on TESTNET. No real funds are involved.

## Getting started

```bash
npm install
cp .env.example .env
# Fill in BOT_TOKEN and ENCRYPTION_KEY_HEX
npm run build   # type-check
npm test        # run all unit/integration tests
```

## Rules

- **No new features** unless they are listed in the open issues. Keep v0.1 small.
- **All tests must pass** (`npm test`) before opening a PR.
- **TypeScript strict mode** — no `any`, no `@ts-ignore` without a comment explaining why.
- **No secrets in code or tests** — use placeholder values only.
- **Testnet only** — no mainnet code paths, no real keys.
- **Read docs/ROLES.md** before changing any transfer state logic. Every new state transition must be added to the table in that file and covered by a test.
- **Read docs/DECISIONS.md** before adding or changing a dependency. Document your choice.

## Pull request checklist

- [ ] `npm run build` passes (TypeScript type-check)
- [ ] `npm test` passes (all tests green)
- [ ] New behaviour is covered by at least one test
- [ ] docs/ROLES.md updated if state machine changed
- [ ] docs/DECISIONS.md updated if a new dependency or architectural decision was made
- [ ] No secrets, no real keys, no mainnet code

## Reporting security issues

See [SECURITY.md](./SECURITY.md).
