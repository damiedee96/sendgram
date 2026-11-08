# SendGram v0.1 — Authorization Model

> ⚠️ CUSTODIAL DEMO — TESTNET ONLY

This document describes what each actor is allowed to do and how those permissions are enforced in code.

---

## Command permissions

| Command | Requires wallet | Who can call it | Enforcement |
|---------|----------------|-----------------|-------------|
| `/start` | No | Any private-chat user | None (wallet created on first call) |
| `/help` | No | Any private-chat user | None |
| `/balance` | Yes | Wallet owner | `findUser(userId)` check |
| `/send` | Yes | Wallet owner | `findUser(userId)` check; self-send rejected |
| `/confirm_send` | Yes | Sender of that transfer | `transfer.sender_id === userId` check |
| `/claim` | Yes | Anyone with the code (bearer) | Code hash lookup; self-claim rejected |
| `/cancel` | Yes | Sender of that transfer | `transfer.sender_id === senderId` check |
| `/history` | Yes | Wallet owner | Filtered to `sender_id = userId OR recipient_id = userId` |

## Private-chat-only

All commands are silently ignored in group or supergroup chats (enforced by `privateChatOnly` middleware). This prevents unintentional disclosure of claim codes in shared chats.

## Rate limiting

Every user is limited to `RATE_LIMIT_MAX` commands per `RATE_LIMIT_WINDOW_SECONDS` window (defaults: 10 per 60 s). Enforced by `rateLimitMiddleware` before any handler runs.

## One-in-flight command per user

`userLockMiddleware` enforces that only one state-mutating command runs at a time per user. The lock TTL is 90 seconds — longer than the Stellar transaction timeout — and is renewed mid-command to prevent expiry. This prevents double-spend races at the bot layer.

## Atomic DB transitions

State transitions that involve an on-chain payment use `UPDATE ... WHERE status = 'pending'` and require `result.changes === 1`. This is the final guard against races after the user lock:

- Two concurrent claimers → exactly one `pending → claiming` transition succeeds.
- A cancellation racing a claim → one of `pending → cancelled` or `pending → claiming` wins; the other gets `changes = 0` and is rejected.

## Wallet key access

- Each wallet's secret key is encrypted with the operator's master key (`ENCRYPTION_KEY_HEX`).
- The user's Telegram ID is bound as additional authenticated data (AAD): `encryptSecretKey(secret, userId)`.
- `decryptSecretKey(blob, userId)` will fail with an authentication error if the userId does not match the one used at encryption time. This prevents a DB-level key-swap attack.
- The decrypted secret key is never logged, never returned to the user, and never stored outside the call stack of the signing operation.

## What this model does NOT protect against

- **Operator compromise:** The bot operator who holds both `ENCRYPTION_KEY_HEX` and the database can decrypt and drain all wallets. There is no technical control that prevents this. This is the central custodial risk — see docs/LIMITATIONS.md.
- **Telegram account takeover:** If a user's Telegram account is compromised, the attacker can issue commands as that user.
- **Claim code interception:** Claim codes are bearer tokens. If the code is intercepted in transit (e.g., in a shared chat), anyone who reads it can claim the transfer.
