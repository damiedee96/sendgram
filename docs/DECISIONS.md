# SendGram v0.1 — Architecture Decision Records

> Sources are verified at the time of writing. Pin exact versions.

---

## ADR-001: Telegram library — grammY 1.46.0

**Decision:** Use [grammY](https://grammy.dev/) (`grammy@1.46.0`).

**Alternatives considered:** Telegraf. Telegraf v4 went without a release for an extended period and its TypeScript types were historically incomplete. grammY is TypeScript-first, actively maintained, and has native first-class support for long polling and webhooks.

**Source:** [grammY GitHub](https://github.com/grammyjs/grammY) (checked 2026-11-08), [grammY vs Telegraf comparison](https://grammy.dev/resources/comparison) (checked 2026-11-08).

---

## ADR-002: Stellar SDK — @stellar/stellar-sdk 17.4.0

**Decision:** Use `@stellar/stellar-sdk@17.4.0`.

**Rationale:** Official SDK maintained by the Stellar Development Foundation. Provides `Keypair`, `TransactionBuilder`, `Operation`, `Asset`, `Horizon.Server`, and `Networks` used throughout the codebase.

**Source:** [Stellar SDK npm](https://www.npmjs.com/package/@stellar/stellar-sdk) (checked 2026-11-08).

---

## ADR-003: Testnet USDC issuer

**Decision:** Use asset code `USDC` with issuer `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`.

**Source:**
- [Circle developer docs — transfer USDC on Stellar](https://developers.circle.com/stablecoins/quickstarts/transfer-usdc-stellar) (checked 2026-11-08): "Testnet: `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`"
- [Stellar developer docs — SEP-6 configuration](https://developers.stellar.org/docs/platforms/anchor-platform/sep-guide/sep6/configuration) (checked 2026-11-08): `issuer = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"`
- Both sources agree. Both are official (Circle is the USDC issuer; Stellar is the network operator).

Issuer is configurable via `USDC_ASSET_ISSUER` env var but defaults to the above.

---

## ADR-004: Wallet encryption — XChaCha20-Poly1305 via libsodium-wrappers 0.8.4

**Decision:** Use `libsodium-wrappers@0.8.4` for authenticated encryption of wallet secret keys.

**Algorithm:** `crypto_aead_xchacha20poly1305_ietf_encrypt` / `_decrypt`.
- 192-bit random nonce (prevents nonce reuse risk of standard ChaCha20).
- Poly1305 authentication tag provides tamper detection.
- User ID encoded as 8-byte big-endian AAD — a ciphertext for user A cannot be decrypted as user B's key.

**Alternatives considered:** Node.js `crypto` AES-256-GCM. libsodium was chosen because it provides a higher-level API that is harder to misuse (no manual IV management, integrated authentication).

**Source:** [libsodium documentation](https://doc.libsodium.org/secret-key_cryptography/aead/chacha20-poly1305/xchacha20-poly1305_construction) (checked 2026-11-08). libsodium ships its own TypeScript types; `@types/libsodium-wrappers` is a stub and was removed.

---

## ADR-005: Database — better-sqlite3 13.0.3

**Decision:** Use `better-sqlite3@13.0.3` (synchronous SQLite).

**Rationale:** Synchronous API matches the single-process, single-threaded nature of the bot. WAL mode provides enough concurrency for a single-node v0.1. The synchronous API makes transaction reasoning straightforward and avoids async callback complexity.

**Source:** [better-sqlite3 npm](https://www.npmjs.com/package/better-sqlite3) (checked 2026-11-08).

---

## ADR-006: Atomic state machine for transfers

**Decision:** Use `UPDATE transfers SET status = ? WHERE id = ? AND status = ?` for all claim and cancel transitions. Check `result.changes === 1` to detect a lost race.

**Rationale:** SQLite serialises writes; the WHERE clause on the current status means exactly one concurrent operation can win. The loser gets `changes === 0` and throws an appropriate error without executing the on-chain payment. On payment failure, the transition is reversed (`claiming → pending`) so the sender/claimant can retry.

---

## ADR-007: Long polling (not webhook)

**Decision:** Use grammY long polling for v0.1.

**Rationale:** Simplest deployment path. No TLS/reverse-proxy setup required for a demo. Webhooks can be added in v0.2 with a single grammY config change.

---

## ADR-008: User lock TTL — 90 seconds

**Decision:** Set `USER_LOCK_TTL_SECONDS = 90`.

**Rationale:** Stellar's `TransactionBuilder.setTimeout(30)` means a transaction can remain in flight for up to 30 seconds. Adding a 60-second buffer (total 90 s) ensures the lock outlives any in-flight payment. The lock is also renewed every 45 seconds (half-TTL) via `setInterval` in `userLockMiddleware` so a slow command never loses its lock mid-flight.

---

## ADR-009: Confirmation step for direct transfers

**Decision:** `/send` stages the transfer in `pending` state and shows a confirmation prompt. The user must send `/confirm_send <id>` to execute the payment.

**Rationale:** Prevents accidental payments from a typo in the recipient ID. The staging + confirm pattern also means the atomic `pending → claiming` transition covers the confirm step, preventing double-sends from button mashing.
