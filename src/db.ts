/**
 * SendGram v0.1 — CUSTODIAL DEMO
 * SQLite database layer via better-sqlite3 (synchronous API).
 *
 * Schema:
 *   users         — one row per Telegram user (wallet, encrypted secret key)
 *   transfers     — all transfer records (direct + pending claim)
 *   rate_limits   — sliding-window counters for rate limiting
 *   user_locks    — advisory lock table for one-in-flight-command-per-user
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type TransferStatus = "pending" | "completed" | "cancelled" | "expired";

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
  amount_stroops: string;   // store as TEXT to avoid JS float precision issues (7 decimal USDC)
  status: TransferStatus;
  claim_code_hash: string | null;
  expires_at: number | null;    // Unix timestamp; null = direct (no code)
  stellar_tx_hash: string | null;
  idempotency_key: string;      // unique per operation attempt
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
                          CHECK(status IN ('pending','completed','cancelled','expired')),
      claim_code_hash   TEXT    UNIQUE,
      expires_at        INTEGER,
      stellar_tx_hash   TEXT,
      idempotency_key   TEXT    NOT NULL UNIQUE,
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
export function createTransfer(transfer: Omit<TransferRow, "created_at" | "updated_at">): TransferRow {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO transfers
      (id, sender_id, recipient_id, amount_stroops, status, claim_code_hash,
       expires_at, stellar_tx_hash, idempotency_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    transfer.id,
    transfer.sender_id,
    transfer.recipient_id ?? null,
    transfer.amount_stroops,
    transfer.status,
    transfer.claim_code_hash ?? null,
    transfer.expires_at ?? null,
    transfer.stellar_tx_hash ?? null,
    transfer.idempotency_key,
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

export function updateTransferStatus(
  id: string,
  status: TransferStatus,
  extra: { recipientId?: number; stellarTxHash?: string } = {}
): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    UPDATE transfers
    SET status = ?,
        recipient_id = COALESCE(?, recipient_id),
        stellar_tx_hash = COALESCE(?, stellar_tx_hash),
        updated_at = ?
    WHERE id = ?
  `).run(
    status,
    extra.recipientId ?? null,
    extra.stellarTxHash ?? null,
    now,
    id
  );
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
 * Sum of USDC (in stroops) sent by a user in the past 24 hours
 * for status = 'completed' or 'pending'.
 */
export function dailySentAmount(userId: number): bigint {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - 86400;
  const row = db
    .prepare<[number, number], { total: string | null }>(`
      SELECT SUM(CAST(amount_stroops AS INTEGER)) AS total
      FROM transfers
      WHERE sender_id = ?
        AND status IN ('completed', 'pending')
        AND created_at >= ?
    `)
    .get(userId, cutoff);
  return BigInt(row?.total ?? "0");
}

/** Expire pending transfers past their expiry time. */
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
export function acquireUserLock(userId: number): boolean {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  // Release stale locks older than 30 seconds
  db.prepare("DELETE FROM user_locks WHERE locked_at < ?").run(now - 30);
  try {
    db.prepare(
      "INSERT INTO user_locks (user_id, locked_at) VALUES (?, ?)"
    ).run(userId, now);
    return true;
  } catch {
    return false; // UNIQUE constraint → already locked
  }
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
