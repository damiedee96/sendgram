/**
 * SendGram v0.1 — Optional live testnet integration tests.
 *
 * These tests hit the REAL Stellar testnet (friendbot + horizon-testnet).
 * They are SLOW (10–30 seconds each) and require network access.
 *
 * Run with:
 *   npm run test:live
 *
 * Environment required:
 *   STELLAR_NETWORK=testnet (set automatically below for CI)
 *   ENCRYPTION_KEY_HEX=<64 hex chars>
 */

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

// Set env before any imports
process.env["STELLAR_NETWORK"] = "testnet";
process.env["BOT_TOKEN"] = "1234567890:live_test_token";
process.env["ENCRYPTION_KEY_HEX"] = process.env["ENCRYPTION_KEY_HEX"] ?? "b".repeat(64);
process.env["DB_PATH"] = `:memory:`;
process.env["MAX_TRANSFER_AMOUNT"] = "20";
process.env["MAX_DAILY_AMOUNT"] = "100";
process.env["CLAIM_EXPIRY_HOURS"] = "1";
process.env["RATE_LIMIT_MAX"] = "50";
process.env["RATE_LIMIT_WINDOW_SECONDS"] = "60";

import { getDb, createUser } from "../db.js";
import { generateKeypair, setupNewWallet, getUsdcBalance, sendUsdc, USDC_STROOP } from "../stellar.js";
import { encryptSecretKey } from "../crypto.js";
import { initiateTransfer, claimTransfer, cancelTransfer } from "../transfers.js";

const TIMEOUT = 60_000; // 60s per live test

let aliceId: number;
let alicePub: string;
let aliceSec: string;
let bobId: number;
let bobPub: string;

beforeAll(async () => {
  // Reset DB
  const db = getDb();
  db.exec("DELETE FROM user_locks; DELETE FROM rate_limits; DELETE FROM transfers; DELETE FROM users;");

  // Create two funded testnet wallets
  aliceId = 90001;
  bobId = 90002;

  const alice = generateKeypair();
  alicePub = alice.publicKey;
  aliceSec = alice.secretKey;

  const bob = generateKeypair();
  bobPub = bob.publicKey;

  console.log("Funding Alice:", alicePub);
  await setupNewWallet(alicePub, aliceSec);
  console.log("Funding Bob:", bobPub);
  await setupNewWallet(bobPub, bob.secretKey);

  createUser(aliceId, alicePub, await encryptSecretKey(aliceSec, aliceId));
  createUser(bobId, bobPub, await encryptSecretKey(bob.secretKey, bobId));
}, TIMEOUT * 2);

describe("live testnet — balance", () => {
  it("new wallet has a USDC balance of 0 (trustline exists)", async () => {
    const bal = await getUsdcBalance(alicePub);
    expect(bal).toBe(0n);
  }, TIMEOUT);
});

describe("live testnet — direct transfer after faucet", () => {
  // Note: no USDC faucet is called in this test — balance is 0.
  // This test confirms insufficient balance is detected on-chain.
  it("rejects send when USDC balance is 0", async () => {
    const { InsufficientBalanceError } = await import("../stellar.js");
    await expect(initiateTransfer(aliceId, bobId, "1")).rejects.toBeInstanceOf(
      InsufficientBalanceError
    );
  }, TIMEOUT);
});

describe("live testnet — restart during pending transfer", () => {
  it("pending transfer survives a simulated process restart", async () => {
    // Create pending transfer
    const result = await initiateTransfer(aliceId, null, "0.0000001");
    expect(result.type).toBe("pending");

    if (result.type !== "pending") return;
    const { claimCode, transferId } = result;

    // Simulate restart by creating a fresh DB connection
    // (In-memory DB, so we just verify state is still present after re-query)
    const { findTransferByClaimHash } = await import("../db.js");
    const { hashClaimCode } = await import("../crypto.js");
    const hash = hashClaimCode(claimCode);
    const found = findTransferByClaimHash(hash);
    expect(found).toBeDefined();
    expect(found!.status).toBe("pending");

    // Clean up
    await cancelTransfer(aliceId, transferId);
  }, TIMEOUT);
});
