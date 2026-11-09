/**
 * SendGram v0.1 — CUSTODIAL DEMO
 * SQLite database layer via better-sqlite3 (synchronous API).
 *
 * Schema:
 *   users         — one row per Telegram user (wallet, encrypted secret key)
 *   transfers     — all transfer records (direct + pending claim)
 *   rate_limits   — sliding-window counters for rate limiting
 *   user_locks    — advisory lock table for one-in-flight-command-per-user
 *
 * Transfer state machine:
 *   pending → claiming  (atomic UPDATE WHERE status='pending'; claim or cancel)
 *   claiming → completed (payment confirmed)
 *   claiming → pending   (payment failed — revert)
 *   pending → cancelled  (atomic UPDATE WHERE status='pending'; only sender)
 *   pending → expired    (background job; expiry time passed)
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type TransferStatus = "pending" | "claiming" | "completed" | "cancelled" | "expired";

export interface UserRow {
  user_id: number;          // Telegram user ID (bigint stored as INTEGER)
  public_key: string;
  encrypted_secret: string;
  created_at: number;       // Unix timestamp (seconds)
}

export interface TransferRow {
  id: string;               // UUID v4
  sender_id: number;
  recipient_id: number | null;  // null until claimed
  amount_stroops: string;   // TEXT to avoid JS float precision issues (7 decimal USDC)
  status: TransferStatus;
  claim_code_hash: string | null;
  expires_at: number | null;    // Unix timestamp; null = direct (no code)
  stellar_tx_hash: string | null;
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Initialise
// ---------------------------------------------------------------------------
let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  // Ensure data directory exists
  mkdirSync(dirname(config.dbPath), { recursive: true });

  _db = new Database(config.dbPath);

  // WAL mode for better concurrency
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _db.pragma("busy_timeout = 5000");

  applyMigrations(_db);
  return _db;
}

// For tests: close and reset the singleton.
export function _resetDb(): void {
  _db?.close();
  _db = null;
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------
function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      user_id          INTEGER PRIMARY KEY,
      public_key       TEXT    NOT NULL UNIQUE,
      encrypted_secret TEXT    NOT NULL,
      created_at       INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS transfers (
      id                TEXT PRIMARY KEY,
      sender_id         INTEGER NOT NULL,
      recipient_id      INTEGER,
      amount_stroops    TEXT    NOT NULL,
      status            TEXT    NOT NULL DEFAULT 'pending'
                          CHECK(status IN ('pending','claiming','completed','cancelled','expired')),
      claim_code_hash   TEXT    UNIQUE,
      expires_at        INTEGER,
      stellar_tx_hash   TEXT,
      created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at        INTEGER NOT NULL DEFAULT (unixepoch()),
      FOREIGN KEY(sender_id) REFERENCES users(user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_transfers_sender ON transfers(sender_id);
    CREATE INDEX IF NOT EXISTS idx_transfers_recipient ON transfers(recipient_id);
    CREATE INDEX IF NOT EXISTS idx_transfers_status ON transfers(status);
    CREATE INDEX IF NOT EXISTS idx_transfers_claim_hash ON transfers(claim_code_hash);

    CREATE TABLE IF NOT EXISTS rate_limits (
      user_id    INTEGER NOT NULL,
      window_key TEXT    NOT NULL,  -- e.g. "60:1234567" (windowSeconds:windowStart)
      count      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id, window_key)
    );

    CREATE TABLE IF NOT EXISTS user_locks (
      user_id    INTEGER PRIMARY KEY,
      locked_at  INTEGER NOT NULL
    );
  `);
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
export function findUser(userId: number): UserRow | undefined {
  const db = getDb();
  return db
    .prepare<[number], UserRow>(
      "SELECT user_id, public_key, encrypted_secret, created_at FROM users WHERE user_id = ?"
    )
    .get(userId);
}

export function createUser(
  userId: number,
  publicKey: string,
  encryptedSecret: string
): UserRow {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    "INSERT INTO users (user_id, public_key, encrypted_secret, created_at) VALUES (?, ?, ?, ?)"
  ).run(userId, publicKey, encryptedSecret, now);
  return { user_id: userId, public_key: publicKey, encrypted_secret: encryptedSecret, created_at: now };
}

export function findUserByPublicKey(publicKey: string): UserRow | undefined {
  const db = getDb();
  return db
    .prepare<[string], UserRow>(
      "SELECT user_id, public_key, encrypted_secret, created_at FROM users WHERE public_key = ?"
    )
    .get(publicKey);
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------
export function createTransfer(
  transfer: Omit<TransferRow, "created_at" | "updated_at">
): TransferRow {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO transfers
      (id, sender_id, recipient_id, amount_stroops, status, claim_code_hash,
       expires_at, stellar_tx_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    transfer.id,
    transfer.sender_id,
    transfer.recipient_id ?? null,
    transfer.amount_stroops,
    transfer.status,
    transfer.claim_code_hash ?? null,
    transfer.expires_at ?? null,
    transfer.stellar_tx_hash ?? null,
    now,
    now
  );
  return { ...transfer, created_at: now, updated_at: now };
}

export function findTransfer(id: string): TransferRow | undefined {
  const db = getDb();
  return db
    .prepare<[string], TransferRow>("SELECT * FROM transfers WHERE id = ?")
    .get(id);
}

export function findTransferByClaimHash(hash: string): TransferRow | undefined {
  const db = getDb();
  return db
    .prepare<[string], TransferRow>(
      "SELECT * FROM transfers WHERE claim_code_hash = ?"
    )
    .get(hash);
}

/**
 * Atomically move a transfer from `fromStatus` to `toStatus`.
 * Returns true if exactly one row was updated; false if the row was already
 * in a different state (lost the race).
 */
export function atomicStatusTransition(
  id: string,
  fromStatus: TransferStatus,
  toStatus: TransferStatus,
  extra: { recipientId?: number; stellarTxHash?: string } = {}
): boolean {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(`
    UPDATE transfers
    SET status = ?,
        recipient_id = COALESCE(?, recipient_id),
        stellar_tx_hash = COALESCE(?, stellar_tx_hash),
        updated_at = ?
    WHERE id = ? AND status = ?
  `).run(
    toStatus,
    extra.recipientId ?? null,
    extra.stellarTxHash ?? null,
    now,
    id,
    fromStatus
  );
  return result.changes === 1;
}

export function getTransferHistory(userId: number, limit = 10): TransferRow[] {
  const db = getDb();
  return db
    .prepare<[number, number, number], TransferRow>(`
      SELECT * FROM transfers
      WHERE sender_id = ? OR recipient_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(userId, userId, limit);
}

/**
 * Sum of USDC (in stroops) reserved by a sender:
 * status IN ('pending', 'claiming') in the past 24 hours.
 * Used for daily cap and available-balance checks.
 */
export function reservedAmount(userId: number): bigint {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - 86400;
  const row = db
    .prepare<[number, number], { total: string | null }>(`
      SELECT SUM(CAST(amount_stroops AS INTEGER)) AS total
      FROM transfers
      WHERE sender_id = ?
        AND status IN ('pending', 'claiming')
        AND created_at >= ?
    `)
    .get(userId, cutoff);
  return BigInt(row?.total ?? "0");
}

/**
 * Sum of USDC (in stroops) sent by a user in the past 24 hours
 * for status = 'completed', 'pending', or 'claiming' (all reserved or spent).
 */
export function dailySentAmount(userId: number): bigint {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - 86400;
  const row = db
    .prepare<[number, number], { total: string | null }>(`
      SELECT SUM(CAST(amount_stroops AS INTEGER)) AS total
      FROM transfers
      WHERE sender_id = ?
        AND status IN ('completed', 'pending', 'claiming')
        AND created_at >= ?
    `)
    .get(userId, cutoff);
  return BigInt(row?.total ?? "0");
}

/** Expire pending transfers past their expiry time. Does NOT expire 'claiming'. */
export function expirePendingTransfers(): number {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const result = db
    .prepare(`
      UPDATE transfers
      SET status = 'expired', updated_at = ?
      WHERE status = 'pending'
        AND expires_at IS NOT NULL
        AND expires_at < ?
    `)
    .run(now, now);
  return result.changes;
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
/**
 * Increment the counter for a user in the current window.
 * Returns true if allowed, false if rate-limited.
 */
export function checkRateLimit(userId: number): boolean {
  const db = getDb();
  const windowSeconds = config.rateLimitWindowSeconds;
  const max = config.rateLimitMax;
  const windowStart = Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
  const windowKey = `${windowSeconds}:${windowStart}`;

  const row = db
    .prepare<[number, string], { count: number }>(
      "SELECT count FROM rate_limits WHERE user_id = ? AND window_key = ?"
    )
    .get(userId, windowKey);

  if (row && row.count >= max) return false;

  db.prepare(`
    INSERT INTO rate_limits (user_id, window_key, count)
    VALUES (?, ?, 1)
    ON CONFLICT(user_id, window_key) DO UPDATE SET count = count + 1
  `).run(userId, windowKey);

  return true;
}

// ---------------------------------------------------------------------------
// User locks (one in-flight command per user)
// ---------------------------------------------------------------------------

/**
 * Lock expiry: longer than the Stellar transaction timeout (30 s) plus margin.
 * The Stellar SDK uses a 30-second transaction timeout; we use 90 s so the
 * lock outlives any in-flight payment.
 */
export const USER_LOCK_TTL_SECONDS = 90;

export function acquireUserLock(userId: number): boolean {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  // Release stale locks older than TTL
  db.prepare("DELETE FROM user_locks WHERE locked_at < ?").run(now - USER_LOCK_TTL_SECONDS);
  try {
    db.prepare(
      "INSERT INTO user_locks (user_id, locked_at) VALUES (?, ?)"
    ).run(userId, now);
    return true;
  } catch {
    return false; // UNIQUE constraint → already locked
  }
}

/**
 * Refresh the timestamp on an existing lock so it doesn't expire mid-command.
 * Should be called periodically for long-running operations.
 */
export function renewUserLock(userId: number): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare("UPDATE user_locks SET locked_at = ? WHERE user_id = ?").run(now, userId);
}

export function releaseUserLock(userId: number): void {
  const db = getDb();
  db.prepare("DELETE FROM user_locks WHERE user_id = ?").run(userId);
}

// ---------------------------------------------------------------------------
// Transactions helper
// ---------------------------------------------------------------------------
export function withTransaction<T>(fn: () => T): T {
  const db = getDb();
  return db.transaction(fn)();
}
