# SendGram v0.1 — Limitations and Disclaimers

> ⚠️ **CUSTODIAL DEMO — NOT FOR PRODUCTION USE**

This document lists the known limitations and risks of SendGram v0.1.
Read it before deploying or sharing this bot.

---

## 1. Custodial Architecture

**SendGram is custodial.** The bot holds every user's Stellar secret key in its own database, encrypted at rest. Users do not control their own private keys. This means:

- If the server is compromised, attackers can decrypt and drain all wallets.
- If the encryption key is lost, all wallets are permanently inaccessible.
- Users must trust the bot operator with their testnet funds.

This design was chosen for simplicity in v0.1. It is not appropriate for real funds.

---

## 2. Single Encryption Key Protects All Wallets

All wallet secret keys are encrypted with **one master key** (`ENCRYPTION_KEY_HEX`). This is a single point of failure:

- A stolen or leaked `ENCRYPTION_KEY_HEX` compromises every wallet simultaneously.
- There is no per-user key derivation or key rotation mechanism.
- Anyone with database access plus the encryption key can steal all wallets.

**Next step:** Move to per-wallet key derivation (e.g., HKDF from the master key and a per-user salt) or, better still, non-custodial signing (see §6).

---

## 3. Claim Codes Are Bearer Secrets

Pending transfer claim codes are **bearer tokens**: anyone who possesses the code can claim the transfer. The bot warns users about this in every message that shows a claim code.

- Codes are 128-bit random values (32 hex chars), stored only as SHA-256 hashes in the database.
- Codes expire after 72 hours (configurable) and can be cancelled by the sender before expiry.
- Codes must be transmitted securely by the user (e.g. via an encrypted channel). The bot does not provide a secure channel.

---

## 4. Testnet Only

This bot is hard-coded to reject startup unless `STELLAR_NETWORK=testnet`. It uses:

- **Stellar Testnet Horizon:** `https://horizon-testnet.stellar.org`
- **Stellar Friendbot:** `https://friendbot.stellar.org`
- **Testnet USDC issuer (Circle):** `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`
- **Asset code:** `USDC`

Testnet assets have **no real-world value**. Do not attempt to deploy this bot on Stellar Mainnet.

---

## 5. Not Audited

This code has not undergone a security audit. Known classes of issues that have not been independently verified:

- Timing attacks on claim code comparison (mitigated by hashing before DB lookup, but not formally verified)
- SQLite locking behaviour under high concurrency
- Telegram Bot API edge cases (message editing, forwarding, etc.)
- Cryptographic implementation correctness of libsodium integration

---

## 6. Non-Custodial Signing — Next Step

The most impactful improvement to v0.2 would be eliminating custody entirely:

**Option A — SEP-0007 / Wallet Connect:** Generate unsigned transactions server-side, send deep-links to users' own Stellar wallets (e.g. Lobstr, Solar) for signing. The bot never sees a secret key.

**Option B — Client-side key management:** Use a Telegram Mini App where the user's browser holds the secret key. The bot only orchestrates; the user signs locally.

Either approach eliminates the single-key-protects-all-wallets risk and moves responsibility for key security to the user's own wallet.

---

## 7. Other Known Gaps

| Item | Status |
|------|--------|
| No key rotation / re-encryption | Not implemented |
| No per-wallet key derivation | Not implemented |
| No 2FA or withdrawal confirmation | Not implemented |
| SQLite only (no horizontal scaling) | By design for v0.1 |
| Long polling only (no webhook) | By design for v0.1 |
| No fee estimation / fee bumping | Hardcoded 100 stroops base fee |
| No multi-sig support | Not in scope |
| No mainnet support | Intentionally blocked |
