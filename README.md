# SendGram v0.1

> ⚠️ **CUSTODIAL DEMO — TESTNET ONLY — NOT AUDITED**
>
> This bot holds testnet wallet keys. Do NOT use for real funds.
> See [LIMITATIONS.md](./LIMITATIONS.md) for full details.

A Telegram bot for USDC transfers on the **Stellar Testnet**.

## Features

- `/start` — Create a custodial testnet wallet (funded via friendbot + USDC trustline)
- `/balance` — Check USDC balance
- `/send <user_id> <amount>` — Send USDC directly, or create a claim code if the recipient hasn't registered
- `/claim <code>` — Claim a pending transfer (anyone with the code can claim it)
- `/cancel <transfer_id>` — Cancel an unclaimed transfer
- `/history` — Last 10 transfers
- `/help` — Full help

## Requirements

- Node.js 18+
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env — at minimum set BOT_TOKEN and generate an ENCRYPTION_KEY_HEX

# Generate ENCRYPTION_KEY_HEX:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 3. Run
npm start
```

## Environment Variables

See [`.env.example`](./.env.example) for full documentation.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BOT_TOKEN` | ✅ | — | Telegram bot token |
| `ENCRYPTION_KEY_HEX` | ✅ | — | 64-char hex master key for wallet encryption |
| `STELLAR_NETWORK` | ✅ | — | Must be `testnet` — hard-fails on anything else |
| `USDC_ASSET_CODE` | | `USDC` | USDC asset code |
| `USDC_ASSET_ISSUER` | | `GBBD47IF6LWK7P7...` | Circle testnet USDC issuer |
| `MAX_TRANSFER_AMOUNT` | | `100` | Per-transfer cap (USDC) |
| `MAX_DAILY_AMOUNT` | | `500` | Daily send cap per user (USDC) |
| `CLAIM_EXPIRY_HOURS` | | `72` | Claim code expiry in hours |
| `RATE_LIMIT_MAX` | | `10` | Max commands per window |
| `RATE_LIMIT_WINDOW_SECONDS` | | `60` | Rate limit window in seconds |
| `DB_PATH` | | `data/sendgram.db` | SQLite database file path |

## Running Tests

```bash
# Unit + integration tests (mocked Stellar + Telegram)
npm test

# Optional live testnet tests (requires network, ~30–60 seconds)
npm run test:live
```

## Architecture

```
src/
  index.ts          — Entry point
  config.ts         — Env validation (hard-fails on non-testnet)
  crypto.ts         — XChaCha20-Poly1305 wallet encryption (libsodium)
  db.ts             — SQLite schema + queries (better-sqlite3)
  stellar.ts        — Stellar SDK: keypairs, payments, balance
  wallet.ts         — Wallet creation and secret key access
  transfers.ts      — Transfer business logic (send/claim/cancel)
  expiry.ts         — Background job to expire old pending transfers
  logger.ts         — Structured logger (redacts secrets)
  bot/
    index.ts        — grammY bot setup
    middleware.ts   — Private-chat guard, rate limiting, user locks
    commands/       — One file per Telegram command
    utils.ts        — MarkdownV2 escape helper
  tests/            — Vitest test suite
```

## Testnet USDC

The Circle testnet USDC issuer used is:
```
GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
```

Source: [Circle Developer Docs](https://developers.circle.com/stablecoins/quickstarts/transfer-usdc-stellar) and [Stellar Developer Docs](https://developers.stellar.org/docs/platforms/anchor-platform/sep-guide/sep6/configuration).

## Limitations

See [LIMITATIONS.md](./LIMITATIONS.md).
