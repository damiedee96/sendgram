/**
 * SendGram v0.1 — Transfer business logic tests.
 * Items 1, 2: atomic state, fund reservation, race conditions.
 */

import "./mocks.js";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Mock stellar and wallet before any imports that load them
// ---------------------------------------------------------------------------
vi.mock("../stellar.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../stellar.js")>();
  return {
    ...actual,
    sendUsdc: vi.fn().mockResolvedValue("mock_tx_hash_abcdef"),
    getUsdcBalance: vi.fn().mockResolvedValue(50n * actual.USDC_STROOP),
    setupNewWallet: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../wallet.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../wallet.js")>();
  return {
    ...actual,
    getSecretKey: vi.fn().mockResolvedValue("SBFGFF27Y64ZUGFAIG5AMJGQODZZKV74T6HIOK4MHKF37ZMCQ4TPQF7"),
  };
});

import { getDb, createUser, atomicStatusTransition, createTransfer } from "../db.js";
import {
  initiateTransfer,
  confirmDirectTransfer,
  claimTransfer,
  cancelTransfer,
  ClaimError,
  CancelError,
} from "../transfers.js";
import { sendUsdc, getUsdcBalance, USDC_STROOP, InsufficientBalanceError } from "../stellar.js";
import { hashClaimCode } from "../crypto.js";

const mockSendUsdc = vi.mocked(sendUsdc);
const mockGetUsdcBalance = vi.mocked(getUsdcBalance);

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
// initiateTransfer — direct (stages only, no payment yet)
// ---------------------------------------------------------------------------
describe("initiateTransfer — direct", () => {
  it("stages a pending transfer and returns direct_pending_confirm", async () => {
    seedUsers();
    const result = await initiateTransfer(1001, 1002, "5");
    expect(result.type).toBe("direct_pending_confirm");
    if (result.type === "direct_pending_confirm") {
      expect(result.amount).toBe("5");
      expect(result.recipientId).toBe(1002);
    }
    // No on-chain payment yet
    expect(mockSendUsdc).not.toHaveBeenCalled();
  });

  it("rejects insufficient available balance (after reservations)", async () => {
    seedUsers();
    // Reserve 45 USDC via a pending transfer first
    await initiateTransfer(1001, null, "45");
    // Available: 50 - 45 = 5 USDC; trying to send 10 should fail
    await expect(initiateTransfer(1001, 1002, "10")).rejects.toBeInstanceOf(InsufficientBalanceError);
    expect(mockSendUsdc).not.toHaveBeenCalled();
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
    // Balance high enough not to block
    mockGetUsdcBalance.mockResolvedValue(500n * USDC_STROOP);
    for (let i = 0; i < 5; i++) {
      await initiateTransfer(1001, null, "100");
    }
    await expect(initiateTransfer(1001, 1002, "1")).rejects.toBeInstanceOf(AmountError);
  });
});

// ---------------------------------------------------------------------------
// confirmDirectTransfer
// ---------------------------------------------------------------------------
describe("confirmDirectTransfer", () => {
  it("executes payment and marks completed", async () => {
    seedUsers();
    const staged = await initiateTransfer(1001, 1002, "5");
    if (staged.type !== "direct_pending_confirm") throw new Error("wrong type");
    const result = await confirmDirectTransfer(1001, staged.transferId);
    expect(result.txHash).toBe("mock_tx_hash_abcdef");
    expect(result.amount).toBe("5");
    expect(mockSendUsdc).toHaveBeenCalledTimes(1);
  });

  it("reverts to pending when payment fails", async () => {
    seedUsers();
    mockSendUsdc.mockRejectedValueOnce(new Error("Stellar network error"));
    const staged = await initiateTransfer(1001, 1002, "5");
    if (staged.type !== "direct_pending_confirm") throw new Error("wrong type");
    await expect(confirmDirectTransfer(1001, staged.transferId)).rejects.toThrow("Stellar network error");
    // Transfer should be back in pending
    const db = getDb();
    const row = db.prepare("SELECT status FROM transfers WHERE id = ?").get(staged.transferId) as { status: string };
    expect(row.status).toBe("pending");
  });

  it("cannot confirm twice (second attempt fails atomically)", async () => {
    seedUsers();
    const staged = await initiateTransfer(1001, 1002, "5");
    if (staged.type !== "direct_pending_confirm") throw new Error("wrong type");
    await confirmDirectTransfer(1001, staged.transferId);
    await expect(confirmDirectTransfer(1001, staged.transferId)).rejects.toThrow("no longer pending");
  });
});

// ---------------------------------------------------------------------------
// initiateTransfer — pending (claim code)
// ---------------------------------------------------------------------------
describe("initiateTransfer — pending", () => {
  it("creates pending transfer with claim code when recipient is null", async () => {
    seedUsers();
    const result = await initiateTransfer(1001, null, "10");
    expect(result.type).toBe("pending");
    if (result.type === "pending") {
      expect(result.claimCode).toMatch(/^[0-9a-f]{32}$/);
      expect(result.amount).toBe("10");
    }
    expect(mockSendUsdc).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// claimTransfer — atomic state + races
// ---------------------------------------------------------------------------
describe("claimTransfer", () => {
  it("completes a pending transfer", async () => {
    seedUsers();
    const pending = await initiateTransfer(1001, null, "5");
    if (pending.type !== "pending") throw new Error("wrong");
    const result = await claimTransfer(1002, pending.claimCode);
    expect(result.txHash).toBe("mock_tx_hash_abcdef");
    expect(result.senderId).toBe(1001);
  });

  it("rejects double claim", async () => {
    seedUsers();
    const pending = await initiateTransfer(1001, null, "5");
    if (pending.type !== "pending") throw new Error("wrong");
    await claimTransfer(1002, pending.claimCode);
    await expect(claimTransfer(1002, pending.claimCode)).rejects.toBeInstanceOf(ClaimError);
  });

  it("reverts to pending when payment fails", async () => {
    seedUsers();
    mockSendUsdc.mockRejectedValueOnce(new Error("Stellar down"));
    const pending = await initiateTransfer(1001, null, "5");
    if (pending.type !== "pending") throw new Error("wrong");
    await expect(claimTransfer(1002, pending.claimCode)).rejects.toThrow("Stellar down");
    // Should be back in pending — a second attempt can succeed
    mockSendUsdc.mockResolvedValueOnce("recovery_tx_hash");
    const result = await claimTransfer(1002, pending.claimCode);
    expect(result.txHash).toBe("recovery_tx_hash");
  });

  it("two concurrent claimers: exactly one payment fires", async () => {
    seedUsers();
    createUser(1003, "GPUBKEY1003", "enc3");
    const pending = await initiateTransfer(1001, null, "5");
    if (pending.type !== "pending") throw new Error("wrong");

    // Simulate two simultaneous claim attempts
    let paymentCount = 0;
    mockSendUsdc.mockImplementation(async () => {
      paymentCount++;
      return "tx_" + paymentCount;
    });

    const [r1, r2] = await Promise.allSettled([
      claimTransfer(1002, pending.claimCode),
      claimTransfer(1003, pending.claimCode),
    ]);

    // Exactly one should succeed
    const successes = [r1, r2].filter((r) => r.status === "fulfilled");
    const failures = [r1, r2].filter((r) => r.status === "rejected");
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(paymentCount).toBe(1);
  });

  it("claim vs cancel race: exactly one wins", async () => {
    seedUsers();
    const pending = await initiateTransfer(1001, null, "5");
    if (pending.type !== "pending") throw new Error("wrong");

    // One claims, one cancels simultaneously
    const [r1, r2] = await Promise.allSettled([
      claimTransfer(1002, pending.claimCode),
      cancelTransfer(1001, pending.transferId),
    ]);

    const successes = [r1, r2].filter((r) => r.status === "fulfilled");
    expect(successes).toHaveLength(1);
  });

  it("rejects expired code", async () => {
    seedUsers();
    const code = "e".repeat(32);
    const hash = hashClaimCode(code);
    createTransfer({
      id: randomUUID(),
      sender_id: 1001,
      recipient_id: null,
      amount_stroops: "5000000",
      status: "pending",
      claim_code_hash: hash,
      expires_at: Math.floor(Date.now() / 1000) - 1,
      stellar_tx_hash: null,
    });
    await expect(claimTransfer(1002, code)).rejects.toBeInstanceOf(ClaimError);
  });

  it("rejects self-claim", async () => {
    seedUsers();
    const pending = await initiateTransfer(1001, null, "5");
    if (pending.type !== "pending") throw new Error("wrong");
    await expect(claimTransfer(1001, pending.claimCode)).rejects.toBeInstanceOf(ClaimError);
  });

  it("rejects invalid code format", async () => {
    seedUsers();
    await expect(claimTransfer(1002, "invalid-code!")).rejects.toBeInstanceOf(ClaimError);
  });

  it("rejects claim of cancelled transfer", async () => {
    seedUsers();
    const pending = await initiateTransfer(1001, null, "5");
    if (pending.type !== "pending") throw new Error("wrong");
    await cancelTransfer(1001, pending.transferId);
    await expect(claimTransfer(1002, pending.claimCode)).rejects.toBeInstanceOf(ClaimError);
  });

  it("insufficient reserved funds blocks claim", async () => {
    seedUsers();
    // Create a claim-code transfer for 50 USDC (max available)
    mockGetUsdcBalance.mockResolvedValue(50n * USDC_STROOP);
    const pending = await initiateTransfer(1001, null, "50");
    if (pending.type !== "pending") throw new Error("wrong");

    // Now mock balance as 0 (drained by another means)
    mockGetUsdcBalance.mockResolvedValue(0n);
    await expect(claimTransfer(1002, pending.claimCode)).rejects.toBeInstanceOf(InsufficientBalanceError);
  });
});

// ---------------------------------------------------------------------------
// cancelTransfer
// ---------------------------------------------------------------------------
describe("cancelTransfer", () => {
  it("cancels a pending transfer", async () => {
    seedUsers();
    const pending = await initiateTransfer(1001, null, "5");
    if (pending.type !== "pending") throw new Error("wrong");
    const result = await cancelTransfer(1001, pending.transferId);
    expect(result.amount).toBe("5");
  });

  it("rejects cancel by wrong user", async () => {
    seedUsers();
    const pending = await initiateTransfer(1001, null, "5");
    if (pending.type !== "pending") throw new Error("wrong");
    await expect(cancelTransfer(1002, pending.transferId)).rejects.toBeInstanceOf(CancelError);
  });

  it("rejects cancel after claim (completed)", async () => {
    seedUsers();
    const pending = await initiateTransfer(1001, null, "5");
    if (pending.type !== "pending") throw new Error("wrong");
    await claimTransfer(1002, pending.claimCode);
    await expect(cancelTransfer(1001, pending.transferId)).rejects.toBeInstanceOf(CancelError);
  });

  it("rejects double cancel", async () => {
    seedUsers();
    const pending = await initiateTransfer(1001, null, "5");
    if (pending.type !== "pending") throw new Error("wrong");
    await cancelTransfer(1001, pending.transferId);
    await expect(cancelTransfer(1001, pending.transferId)).rejects.toBeInstanceOf(CancelError);
  });

  it("rejects cancel of a claiming transfer", async () => {
    seedUsers();
    const pending = await initiateTransfer(1001, null, "5");
    if (pending.type !== "pending") throw new Error("wrong");
    // Manually move to claiming
    atomicStatusTransition(pending.transferId, "pending", "claiming");
    await expect(cancelTransfer(1001, pending.transferId)).rejects.toBeInstanceOf(CancelError);
  });
});

// ---------------------------------------------------------------------------
// Fund reservation
// ---------------------------------------------------------------------------
describe("fund reservation", () => {
  it("available balance is reduced by pending reservations", async () => {
    seedUsers();
    // Balance is 50 USDC. Reserve 40 USDC.
    await initiateTransfer(1001, null, "40");
    // Now only 10 USDC available — trying to stage 15 should fail
    await expect(initiateTransfer(1001, 1002, "15")).rejects.toBeInstanceOf(InsufficientBalanceError);
  });

  it("cancelling a pending transfer releases the reservation", async () => {
    seedUsers();
    mockGetUsdcBalance.mockResolvedValue(50n * USDC_STROOP);
    const r = await initiateTransfer(1001, null, "40");
    if (r.type !== "pending") throw new Error("wrong");
    await cancelTransfer(1001, r.transferId);
    // Now 40 USDC is free again — can stage another 40
    const r2 = await initiateTransfer(1001, null, "40");
    expect(r2.type).toBe("pending");
  });
});
