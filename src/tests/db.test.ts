/**
 * Tests for the database layer.
 */

import "./mocks.js";
import { describe, it, expect, beforeEach } from "vitest";
import {
  createUser,
  findUser,
  createTransfer,
  findTransferByClaimHash,
  updateTransferStatus,
  dailySentAmount,
  expirePendingTransfers,
  checkRateLimit,
  acquireUserLock,
  releaseUserLock,
  getDb,
} from "../db.js";
import { hashClaimCode } from "../crypto.js";
import { randomUUID } from "node:crypto";

// Reset the DB between tests using an in-memory database
beforeEach(() => {
  // Drop and recreate tables for isolation
  const db = getDb();
  db.exec(`
    DELETE FROM user_locks;
    DELETE FROM rate_limits;
    DELETE FROM transfers;
    DELETE FROM users;
  `);
});

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

describe("transfers", () => {
  beforeEach(() => {
    createUser(2001, "GPUBKEY2001", "enc_a");
    createUser(2002, "GPUBKEY2002", "enc_b");
  });

  it("creates a pending transfer with claim hash", async () => {
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
      idempotency_key: randomUUID(),
    });

    const found = findTransferByClaimHash(hash);
    expect(found).toBeDefined();
    expect(found!.status).toBe("pending");
    expect(found!.sender_id).toBe(2001);
  });

  it("updates transfer status to completed", () => {
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
      idempotency_key: randomUUID(),
    });

    updateTransferStatus(id, "completed", {
      recipientId: 2002,
      stellarTxHash: "txhash123",
    });

    const db = getDb();
    const row = db.prepare("SELECT * FROM transfers WHERE id = ?").get(id) as {
      status: string; recipient_id: number; stellar_tx_hash: string;
    };
    expect(row.status).toBe("completed");
    expect(row.recipient_id).toBe(2002);
    expect(row.stellar_tx_hash).toBe("txhash123");
  });

  it("expires transfers past their deadline", async () => {
    const id = randomUUID();
    const pastExpiry = Math.floor(Date.now() / 1000) - 1; // 1 second in the past
    createTransfer({
      id,
      sender_id: 2001,
      recipient_id: null,
      amount_stroops: "1000000",
      status: "pending",
      claim_code_hash: hashClaimCode("c".repeat(32)),
      expires_at: pastExpiry,
      stellar_tx_hash: null,
      idempotency_key: randomUUID(),
    });

    const count = expirePendingTransfers();
    expect(count).toBe(1);

    const db = getDb();
    const row = db.prepare("SELECT status FROM transfers WHERE id = ?").get(id) as { status: string };
    expect(row.status).toBe("expired");
  });

  it("does not expire transfers with future expiry", () => {
    const id = randomUUID();
    createTransfer({
      id,
      sender_id: 2001,
      recipient_id: null,
      amount_stroops: "1000000",
      status: "pending",
      claim_code_hash: hashClaimCode("d".repeat(32)),
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      stellar_tx_hash: null,
      idempotency_key: randomUUID(),
    });

    const count = expirePendingTransfers();
    expect(count).toBe(0);
  });
});

describe("dailySentAmount", () => {
  beforeEach(() => {
    createUser(3001, "GPUBKEY3001", "enc_c");
  });

  it("sums pending and completed transfers in the last 24 hours", () => {
    createTransfer({
      id: randomUUID(),
      sender_id: 3001,
      recipient_id: null,
      amount_stroops: "10000000", // 1 USDC
      status: "pending",
      claim_code_hash: hashClaimCode("e".repeat(32)),
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      stellar_tx_hash: null,
      idempotency_key: randomUUID(),
    });
    createTransfer({
      id: randomUUID(),
      sender_id: 3001,
      recipient_id: null,
      amount_stroops: "20000000", // 2 USDC
      status: "completed",
      claim_code_hash: null,
      expires_at: null,
      stellar_tx_hash: "txhash",
      idempotency_key: randomUUID(),
    });

    const total = dailySentAmount(3001);
    expect(total).toBe(30_000_000n); // 3 USDC
  });
});

describe("rate limiting", () => {
  it("allows requests within the limit", () => {
    for (let i = 0; i < 10; i++) {
      expect(checkRateLimit(4001)).toBe(true);
    }
  });

  it("blocks requests over the limit", () => {
    for (let i = 0; i < 10; i++) {
      checkRateLimit(4002);
    }
    expect(checkRateLimit(4002)).toBe(false);
  });
});

describe("user locks", () => {
  it("acquires and releases a lock", () => {
    expect(acquireUserLock(5001)).toBe(true);
    releaseUserLock(5001);
    expect(acquireUserLock(5001)).toBe(true);
    releaseUserLock(5001);
  });

  it("prevents double lock", () => {
    expect(acquireUserLock(5002)).toBe(true);
    expect(acquireUserLock(5002)).toBe(false);
    releaseUserLock(5002);
  });
});
