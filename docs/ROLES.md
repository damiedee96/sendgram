# SendGram v0.1 — Roles, Secrets, and State Machine

> ⚠️ CUSTODIAL DEMO — TESTNET ONLY

## 1. Actors and Trust

| Actor | What they control | Secrets known | Can they cheat? |
|-------|------------------|---------------|-----------------|
| **Bot operator** | Runs the process, owns `BOT_TOKEN` and `ENCRYPTION_KEY_HEX` | Both master secrets | Yes: can decrypt all wallet keys and drain every wallet. This is the central trust assumption of the custodial model. See docs/LIMITATIONS.md §1. |
| **Sender** | Their own Telegram account | Their Telegram session | Can initiate and cancel own transfers. Cannot cancel another user's transfer. Cannot claim their own code. |
| **Claimant** | Holds the claim code | The 32-hex claim code (bearer token) | Anyone holding the code can claim — this is by design and disclosed in every message that shows a code. |
| **Recipient** | Their own Telegram account | Their Telegram session | Receives funds on-chain. Has no control over the transfer before claim. |
| **Stellar network** | The testnet ledger | N/A | Executes submitted transactions; cannot be cheated by this bot. |

### Secret inventory

| Secret | Holder | Risk if leaked |
|--------|--------|----------------|
| `BOT_TOKEN` | Bot operator | Attacker can impersonate the bot and read all messages |
| `ENCRYPTION_KEY_HEX` | Bot operator | Attacker who also has the DB can decrypt all wallet secret keys |
| Each wallet `secretKey` (encrypted) | Bot operator (DB) | Useless without `ENCRYPTION_KEY_HEX` |
| Claim code (plaintext) | Sender (until shared) | Anyone with the code can claim the transfer |
| Telegram session tokens | Each user | Attacker can issue commands as that user |

---

## 2. Transfer State Machine

```
                   ┌─────────────────────────────────────┐
                   │             pending                  │
                   │  (created by sender; funds reserved) │
                   └──────┬─────────────────┬────────────┘
                          │                 │
              atomicUpdate│                 │atomicUpdate
              (claimer)   │                 │(sender or expiry job)
                          ▼                 ▼
                   ┌──────────┐      ┌────────────┐
                   │ claiming │      │ cancelled  │ ← sender only, WHERE status='pending'
                   │(in-flight│      └────────────┘
                   │ payment) │
                   └──┬───┬───┘      ┌────────────┐
                      │   │          │  expired   │ ← background job, WHERE status='pending'
            success   │   │ failure  └────────────┘
                      ▼   ▼
             ┌──────────────────┐
             │   completed      │ ← terminal; payment confirmed on-chain
             └──────────────────┘
```

### Transition table

| From | To | Trigger | Actor | Condition | Guard |
|------|----|---------|-------|-----------|-------|
| — | `pending` | `/send` or `/confirm_send` | Sender | Valid amount, balance ≥ reserved+amount, daily cap | User lock held |
| `pending` | `claiming` | `/claim` or confirm-direct | Claimer / Sender | `expires_at` not passed; claimer ≠ sender | `UPDATE WHERE status='pending'` — exactly 1 row |
| `pending` | `cancelled` | `/cancel` | Sender only | Transfer belongs to sender | `UPDATE WHERE status='pending'` — exactly 1 row |
| `pending` | `expired` | Expiry job | Background | `expires_at < now()` | `UPDATE WHERE status='pending'` (never touches `claiming`) |
| `claiming` | `completed` | Payment confirmed | Bot (post Stellar) | Stellar tx submitted successfully | `UPDATE WHERE status='claiming'` |
| `claiming` | `pending` | Payment failed | Bot (revert) | Stellar tx submission error | `UPDATE WHERE status='claiming'` — gives claimant a retry |

### Time boundaries

| Boundary | Tested? |
|----------|---------|
| Expiry: `expires_at < now()` blocks claim | ✅ `transfers.test.ts` |
| Expiry job only expires `pending`, not `claiming` | ✅ `db.test.ts` |
| Lock TTL (90 s) > Stellar tx timeout (30 s) | ✅ verified in `db.test.ts` |
| Lock renewal keeps lock alive mid-command | ✅ `db.test.ts` |

### Cheat analysis

| Scenario | Protection |
|----------|-----------|
| Two claimants race on same code | Atomic `UPDATE WHERE status='pending'` — exactly one wins; other gets ClaimError |
| Sender cancels while claimer is claiming | Atomic transitions on different `fromStatus` — one must lose |
| Sender cancels a completed transfer | Status check rejects `completed` |
| Sender sends more than their balance | Available = on-chain − reserved; checked before staging |
| Claimer receives funds when sender balance drained | Balance re-checked at claim time against reserved amounts |
| Wrong user decrypts a wallet secret key | User ID bound as AAD — decryption fails with auth error |
| Double confirm_send | Atomic `pending → claiming` — second attempt finds non-pending, throws |
