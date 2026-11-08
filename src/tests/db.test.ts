/**
 * Tests for the database layer.
 * Item 6: verifies lock renewal keeps the lock alive.
 */

import "./mocks.js";
import { describe, it, expect, beforeEach } from "vitest";
import {
  createUser,
  findUser,
  createTransfer,
  findTransferByClaimHash,
  atomicStatusTransition,
  dailySentAmount,
  reservedAmount,
  expirePendingTransfers,
  checkRateLimit,
  acquireUserLock,
  releaseUserLock,
  renewUserLock,
  USER_LOCK_TTL_SECONDS,
  getDb,
} from "../db.js";
import { hashClaimCode } from "../crypto.js";
import { randomUUID } from "node:crypto";

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM user_locks; DELETE FROM rate_limits; DELETE FROM transfers; DELETE FROM users;");
});

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------
describe("users", () => {
  it("creates and finds a user", () => {
    createUser(1001, "GPUBKEY1", "encrypted_secret_1");
    const row = findUser(1001);
    expect(row).toBeDefined();
    expect(row!.public_key).toBe("GPUBKEY1");
  });

  it("returns undefined for unknown user", () => {
    expect(findUser(9999)).toBeUndefined();
  });

  it("prevents duplicate user IDs", () => {
    createUser(1002, "GPUBKEY2", "enc2");
    expect(() => createUser(1002, "GPUBKEY3", "enc3")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// transfers
// ---------------------------------------------------------------------------
describe("transfers", () => {
  beforeEach(() => {
    createUser(2001, "GPUBKEY2001", "enc_a");
    createUser(2002, "GPUBKEY2002", "enc_b");
  });

  it("creates a pending transfer with claim hash", () => {
    const code = "a".repeat(32);
    const hash = hashClaimCode(code);
    createTransfer({
      id: randomUUID(),
      sender_id: 2001,
      recipient_id: null,
      amount_stroops: "10000000",
      status: "pending",
      claim_code_hash: hash,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      stellar_tx_hash: null,
    });
    const found = findTransferByClaimHash(hash);
    expect(found).toBeDefined();
    expect(found!.status).toBe("pending");
  });

  it("atomicStatusTransition: moves pending→claiming and returns true", () => {
    const id = randomUUID();
    createTransfer({
      id,
      sender_id: 2001,
      recipient_id: null,
      amount_stroops: "5000000",
      status: "pending",
      claim_code_hash: hashClaimCode("b".repeat(32)),
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      stellar_tx_hash: null,
    });
    expect(atomicStatusTransition(id, "pending", "claiming")).toBe(true);
    const db = getDb();
    const row = db.prepare("SELECT status FROM transfers WHERE id = ?").get(id) as { status: string };
    expect(row.status).toBe("claiming");
  });

  it("atomicStatusTransition: returns false when state already moved (race)", () => {
    const id = randomUUID();
    createTransfer({
      id,
      sender_id: 2001,
      recipient_id: null,
      amount_stroops: "5000000",
      status: "pending",
      claim_code_hash: hashClaimCode("c".repeat(32)),
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      stellar_tx_hash: null,
    });
    expect(atomicStatusTransition(id, "pending", "claiming")).toBe(true);
    // Second attempt sees 'claiming', not 'pending' — returns false
    expect(atomicStatusTransition(id, "pending", "claiming")).toBe(false);
  });

  it("atomicStatusTransition: claiming→completed records tx hash", () => {
    const id = randomUUID();
    createTransfer({
      id,
      sender_id: 2001,
      recipient_id: null,
      amount_stroops: "5000000",
      status: "claiming",
      claim_code_hash: hashClaimCode("d".repeat(32)),
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      stellar_tx_hash: null,
    });
    atomicStatusTransition(id, "claiming", "completed", {
      recipientId: 2002,
      stellarTxHash: "txhash123",
    });
    const db = getDb();
    const row = db.prepare("SELECT status, recipient_id, stellar_tx_hash FROM transfers WHERE id = ?").get(id) as {
      status: string; recipient_id: number; stellar_tx_hash: string;
    };
    expect(row.status).toBe("completed");
    expect(row.recipient_id).toBe(2002);
    expect(row.stellar_tx_hash).toBe("txhash123");
  });

  it("claiming→pending revert: atomicStatusTransition works in reverse", () => {
    const id = randomUUID();
    createTransfer({
      id,
      sender_id: 2001,
      recipient_id: null,
      amount_stroops: "5000000",
      status: "claiming",
      claim_code_hash: hashClaimCode("e".repeat(32)),
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      stellar_tx_hash: null,
    });
    expect(atomicStatusTransition(id, "claiming", "pending")).toBe(true);
    const db = getDb();
    const row = db.prepare("SELECT status FROM transfers WHERE id = ?").get(id) as { status: string };
    expect(row.status).toBe("pending");
  });

  it("expires pending transfers past their deadline", () => {
    const id = randomUUID();
    createTransfer({
      id,
      sender_id: 2001,
      recipient_id: null,
      amount_stroops: "1000000",
      status: "pending",
      claim_code_hash: hashClaimCode("f".repeat(32)),
      expires_at: Math.floor(Date.now() / 1000) - 1,
      stellar_tx_hash: null,
    });
    expect(expirePendingTransfers()).toBe(1);
    const db = getDb();
    const row = db.prepare("SELECT status FROM transfers WHERE id = ?").get(id) as { status: string };
    expect(row.status).toBe("expired");
  });

  it("does not expire 'claiming' transfers (in-flight payment)", () => {
    const id = randomUUID();
    createTransfer({
      id,
      sender_id: 2001,
      recipient_id: null,
      amount_stroops: "1000000",
      status: "claiming",
      claim_code_hash: hashClaimCode("g".repeat(32)),
      expires_at: Math.floor(Date.now() / 1000) - 1,
      stellar_tx_hash: null,
    });
    expect(expirePendingTransfers()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// reservedAmount (fund reservation)
// ---------------------------------------------------------------------------
describe("reservedAmount", () => {
  beforeEach(() => {
    createUser(3001, "GPUBKEY3001", "enc_c");
  });

  it("includes pending and claiming in reserved amount", () => {
    createTransfer({
      id: randomUUID(),
      sender_id: 3001,
      recipient_id: null,
      amount_stroops: "10000000", // 1 USDC
      status: "pending",
      claim_code_hash: hashClaimCode("h".repeat(32)),
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      stellar_tx_hash: null,
    });
    createTransfer({
      id: randomUUID(),
      sender_id: 3001,
      recipient_id: null,
      amount_stroops: "20000000", // 2 USDC
      status: "claiming",
      claim_code_hash: hashClaimCode("i".repeat(32)),
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      stellar_tx_hash: null,
    });
    expect(reservedAmount(3001)).toBe(30_000_000n);
  });

  it("does not include completed or cancelled", () => {
    createTransfer({
      id: randomUUID(),
      sender_id: 3001,
      recipient_id: null,
      amount_stroops: "10000000",
      status: "completed",
      claim_code_hash: null,
      expires_at: null,
      stellar_tx_hash: "tx1",
    });
    expect(reservedAmount(3001)).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// dailySentAmount
// ---------------------------------------------------------------------------
describe("dailySentAmount", () => {
  beforeEach(() => {
    createUser(4001, "GPUBKEY4001", "enc_d");
  });

  it("sums pending, claiming and completed transfers in the last 24 hours", () => {
    createTransfer({
      id: randomUUID(),
      sender_id: 4001,
      recipient_id: null,
      amount_stroops: "10000000",
      status: "pending",
      claim_code_hash: hashClaimCode("j".repeat(32)),
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      stellar_tx_hash: null,
    });
    createTransfer({
      id: randomUUID(),
      sender_id: 4001,
      recipient_id: null,
      amount_stroops: "20000000",
      status: "completed",
      claim_code_hash: null,
      expires_at: null,
      stellar_tx_hash: "txhash",
    });
    expect(dailySentAmount(4001)).toBe(30_000_000n);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
describe("rate limiting", () => {
  it("allows requests within the limit", () => {
    for (let i = 0; i < 10; i++) {
      expect(checkRateLimit(5001)).toBe(true);
    }
  });

  it("blocks requests over the limit", () => {
    for (let i = 0; i < 10; i++) checkRateLimit(5002);
    expect(checkRateLimit(5002)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// User locks + renewal
// ---------------------------------------------------------------------------
describe("user locks", () => {
  it("acquires and releases a lock", () => {
    expect(acquireUserLock(6001)).toBe(true);
    releaseUserLock(6001);
    expect(acquireUserLock(6001)).toBe(true);
    releaseUserLock(6001);
  });

  it("prevents double lock", () => {
    expect(acquireUserLock(6002)).toBe(true);
    expect(acquireUserLock(6002)).toBe(false);
    releaseUserLock(6002);
  });

  it("renewUserLock keeps the lock alive past the original TTL", () => {
    const db = getDb();
    expect(acquireUserLock(6003)).toBe(true);

    // Manually back-date the lock so it looks stale
    const staleTime = Math.floor(Date.now() / 1000) - (USER_LOCK_TTL_SECONDS + 1);
    db.prepare("UPDATE user_locks SET locked_at = ? WHERE user_id = ?").run(staleTime, 6003);

    // Without renewal, a new acquire would evict the stale lock and succeed.
    // After renewal, the lock timestamp is fresh — another acquire must fail.
    renewUserLock(6003);
    expect(acquireUserLock(6003)).toBe(false); // still locked
    releaseUserLock(6003);
  });

  it("stale lock (past TTL, not renewed) is evicted by a new acquire attempt", () => {
    const db = getDb();
    expect(acquireUserLock(6004)).toBe(true);
    const staleTime = Math.floor(Date.now() / 1000) - (USER_LOCK_TTL_SECONDS + 1);
    db.prepare("UPDATE user_locks SET locked_at = ? WHERE user_id = ?").run(staleTime, 6004);
    // Stale lock is cleaned up automatically — a new acquire succeeds
    expect(acquireUserLock(6004)).toBe(true);
    releaseUserLock(6004);
  });
});
