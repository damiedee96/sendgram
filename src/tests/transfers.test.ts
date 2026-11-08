/**
 * SendGram v0.1 — Transfer business logic tests.
 * Mocks Stellar SDK; tests DB-level state transitions.
 */

import "./mocks.js";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Mock stellar module before importing transfers
// ---------------------------------------------------------------------------
vi.mock("../stellar.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../stellar.js")>();
  return {
    ...actual,
    sendUsdc: vi.fn().mockResolvedValue("mock_tx_hash_abcdef"),
    getUsdcBalance: vi.fn().mockResolvedValue(50n * actual.USDC_STROOP), // 50 USDC
    setupNewWallet: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock wallet's getSecretKey to avoid real decryption
vi.mock("../wallet.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../wallet.js")>();
  return {
    ...actual,
    getSecretKey: vi.fn().mockResolvedValue("SBFGFF27Y64ZUGFAIG5AMJGQODZZKV74T6HIOK4MHKF37ZMCQ4TPQF7"),
  };
});

import { getDb, createUser } from "../db.js";
import { initiateTransfer, claimTransfer, cancelTransfer, ClaimError, CancelError } from "../transfers.js";
import { sendUsdc, getUsdcBalance, USDC_STROOP, InsufficientBalanceError } from "../stellar.js";
import { hashClaimCode } from "../crypto.js";
import { createTransfer, updateTransferStatus } from "../db.js";

const mockSendUsdc = vi.mocked(sendUsdc);
const mockGetUsdcBalance = vi.mocked(getUsdcBalance);

// Reset DB between tests
beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM user_locks; DELETE FROM rate_limits; DELETE FROM transfers; DELETE FROM users;");
  vi.clearAllMocks();
  mockSendUsdc.mockResolvedValue("mock_tx_hash_abcdef");
  mockGetUsdcBalance.mockResolvedValue(50n * USDC_STROOP);
});

function seedUsers(): void {
  createUser(1001, "GPUBKEY1001", "enc1");
  createUser(1002, "GPUBKEY1002", "enc2");
}

// ---------------------------------------------------------------------------
// initiateTransfer — direct
// ---------------------------------------------------------------------------
describe("initiateTransfer — direct", () => {
  it("sends USDC directly when recipient is registered", async () => {
    seedUsers();
    const result = await initiateTransfer(1001, 1002, "5");
    expect(result.type).toBe("direct");
    if (result.type === "direct") {
      expect(result.amount).toBe("5");
      expect(result.txHash).toBe("mock_tx_hash_abcdef");
    }
    expect(mockSendUsdc).toHaveBeenCalledTimes(1);
  });

  it("rejects insufficient balance", async () => {
    seedUsers();
    mockGetUsdcBalance.mockResolvedValue(1n * USDC_STROOP); // only 1 USDC
    await expect(initiateTransfer(1001, 1002, "5")).rejects.toBeInstanceOf(InsufficientBalanceError);
  });

  it("rejects negative amounts", async () => {
    seedUsers();
    const { AmountError } = await import("../stellar.js");
    await expect(initiateTransfer(1001, 1002, "-1")).rejects.toBeInstanceOf(AmountError);
  });

  it("rejects absurd amounts", async () => {
    seedUsers();
    const { AmountError } = await import("../stellar.js");
    await expect(initiateTransfer(1001, 1002, "999999")).rejects.toBeInstanceOf(AmountError);
  });

  it("rejects injection-style amount strings", async () => {
    seedUsers();
    const { AmountError } = await import("../stellar.js");
    await expect(initiateTransfer(1001, 1002, "; DROP TABLE users")).rejects.toBeInstanceOf(AmountError);
  });

  it("rejects over daily cap", async () => {
    seedUsers();
    const { AmountError } = await import("../stellar.js");
    // Set balance high enough (500 USDC) so balance check doesn't fire first
    mockGetUsdcBalance.mockResolvedValue(500n * USDC_STROOP);
    // Daily cap is 500 USDC; send 100 five times = 500 USDC used
    for (let i = 0; i < 5; i++) {
      await initiateTransfer(1001, 1002, "100");
    }
    // 6th send should exceed daily cap
    await expect(initiateTransfer(1001, 1002, "1")).rejects.toBeInstanceOf(AmountError);
    // Restore default mock
    mockGetUsdcBalance.mockResolvedValue(50n * USDC_STROOP);
  });
});

// ---------------------------------------------------------------------------
// initiateTransfer — pending (no recipient wallet)
// ---------------------------------------------------------------------------
describe("initiateTransfer — pending", () => {
  it("creates a pending transfer with a claim code when recipient is null", async () => {
    seedUsers();
    const result = await initiateTransfer(1001, null, "10");
    expect(result.type).toBe("pending");
    if (result.type === "pending") {
      expect(result.claimCode).toMatch(/^[0-9a-f]{32}$/);
      expect(result.amount).toBe("10");
      expect(result.expiresAt).toBeInstanceOf(Date);
    }
    expect(mockSendUsdc).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// claimTransfer
// ---------------------------------------------------------------------------
describe("claimTransfer", () => {
  it("completes a pending transfer", async () => {
    seedUsers();

    // Create pending transfer
    const pendingResult = await initiateTransfer(1001, null, "5");
    expect(pendingResult.type).toBe("pending");
    if (pendingResult.type !== "pending") return;

    const result = await claimTransfer(1002, pendingResult.claimCode);
    expect(result.txHash).toBe("mock_tx_hash_abcdef");
    expect(result.amount).toBe("5");
    expect(result.senderId).toBe(1001);
  });

  it("rejects double claim", async () => {
    seedUsers();
    const pendingResult = await initiateTransfer(1001, null, "5");
    if (pendingResult.type !== "pending") return;

    await claimTransfer(1002, pendingResult.claimCode);
    await expect(claimTransfer(1002, pendingResult.claimCode)).rejects.toBeInstanceOf(ClaimError);
  });

  it("rejects expired code", async () => {
    seedUsers();

    // Create a transfer with past expiry directly in DB
    const code = "e".repeat(32);
    const hash = hashClaimCode(code);
    createTransfer({
      id: randomUUID(),
      sender_id: 1001,
      recipient_id: null,
      amount_stroops: "5000000",
      status: "pending",
      claim_code_hash: hash,
      expires_at: Math.floor(Date.now() / 1000) - 1, // already expired
      stellar_tx_hash: null,
      idempotency_key: randomUUID(),
    });

    await expect(claimTransfer(1002, code)).rejects.toBeInstanceOf(ClaimError);
  });

  it("rejects wrong user (self-claim)", async () => {
    seedUsers();
    const result = await initiateTransfer(1001, null, "5");
    if (result.type !== "pending") return;

    await expect(claimTransfer(1001, result.claimCode)).rejects.toBeInstanceOf(ClaimError);
  });

  it("rejects invalid code format", async () => {
    seedUsers();
    await expect(claimTransfer(1002, "invalid-code!")).rejects.toBeInstanceOf(ClaimError);
  });

  it("rejects cancelled transfer", async () => {
    seedUsers();
    const result = await initiateTransfer(1001, null, "5");
    if (result.type !== "pending") return;

    await cancelTransfer(1001, result.transferId);
    await expect(claimTransfer(1002, result.claimCode)).rejects.toBeInstanceOf(ClaimError);
  });
});

// ---------------------------------------------------------------------------
// cancelTransfer
// ---------------------------------------------------------------------------
describe("cancelTransfer", () => {
  it("cancels a pending transfer", async () => {
    seedUsers();
    const result = await initiateTransfer(1001, null, "5");
    if (result.type !== "pending") return;

    const cancelResult = await cancelTransfer(1001, result.transferId);
    expect(cancelResult.amount).toBe("5");
  });

  it("rejects cancel by wrong user", async () => {
    seedUsers();
    const result = await initiateTransfer(1001, null, "5");
    if (result.type !== "pending") return;

    await expect(cancelTransfer(1002, result.transferId)).rejects.toBeInstanceOf(CancelError);
  });

  it("rejects cancel after claim", async () => {
    seedUsers();
    const result = await initiateTransfer(1001, null, "5");
    if (result.type !== "pending") return;

    await claimTransfer(1002, result.claimCode);
    await expect(cancelTransfer(1001, result.transferId)).rejects.toBeInstanceOf(CancelError);
  });

  it("rejects double cancel", async () => {
    seedUsers();
    const result = await initiateTransfer(1001, null, "5");
    if (result.type !== "pending") return;

    await cancelTransfer(1001, result.transferId);
    await expect(cancelTransfer(1001, result.transferId)).rejects.toBeInstanceOf(CancelError);
  });
});

// ---------------------------------------------------------------------------
// Concurrent sends (basic test — full concurrent race tested in live suite)
// ---------------------------------------------------------------------------
describe("concurrent sends", () => {
  it("handles two simultaneous transfers without double-spending daily cap", async () => {
    seedUsers();
    // Both sends total 10 USDC — should both succeed (within 500/day cap)
    const [r1, r2] = await Promise.all([
      initiateTransfer(1001, null, "5"),
      initiateTransfer(1001, null, "5"),
    ]);
    expect(r1.type).toBe("pending");
    expect(r2.type).toBe("pending");
  });
});
