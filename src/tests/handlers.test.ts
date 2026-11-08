/**
 * SendGram v0.1 — Handler-level tests.
 * Item 7: tests for /send, /confirm_send, /claim and /cancel handlers
 * with mocked grammY contexts and mocked Stellar calls.
 */

import "./mocks.js";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { CommandContext, Context } from "grammy";

// ---------------------------------------------------------------------------
// Mock the entire transfers module
// ---------------------------------------------------------------------------
vi.mock("../transfers.js", () => ({
  initiateTransfer: vi.fn(),
  confirmDirectTransfer: vi.fn(),
  claimTransfer: vi.fn(),
  cancelTransfer: vi.fn(),
  getHistory: vi.fn().mockReturnValue([]),
  ClaimError: class ClaimError extends Error {
    constructor(msg: string) { super(msg); this.name = "ClaimError"; }
  },
  CancelError: class CancelError extends Error {
    constructor(msg: string) { super(msg); this.name = "CancelError"; }
  },
}));

vi.mock("../stellar.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../stellar.js")>();
  return {
    ...actual,
    sendUsdc: vi.fn().mockResolvedValue("handler_tx_hash"),
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

import { getDb, createUser } from "../db.js";
import {
  initiateTransfer,
  confirmDirectTransfer,
  claimTransfer,
  cancelTransfer,
  ClaimError,
  CancelError,
} from "../transfers.js";
import { InsufficientBalanceError } from "../stellar.js";
import { handleSend } from "../bot/commands/send.js";
import { handleConfirmSend } from "../bot/commands/confirm_send.js";
import { handleClaim } from "../bot/commands/claim.js";
import { handleCancel } from "../bot/commands/cancel.js";

const mockInitiate = vi.mocked(initiateTransfer);
const mockConfirm = vi.mocked(confirmDirectTransfer);
const mockClaim = vi.mocked(claimTransfer);
const mockCancel = vi.mocked(cancelTransfer);

// DB cleanup
beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM user_locks; DELETE FROM rate_limits; DELETE FROM transfers; DELETE FROM users;");
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function makeCtx(userId: number, match: string): CommandContext<Context> {
  return {
    from: { id: userId, first_name: "T", is_bot: false, language_code: "en" },
    chat: { id: userId, type: "private" },
    match,
    reply: vi.fn().mockResolvedValue(undefined),
    message: { text: "/cmd " + match },
    update: { update_id: 1 },
  } as unknown as CommandContext<Context>;
}

// ---------------------------------------------------------------------------
// /send handler
// ---------------------------------------------------------------------------
describe("/send handler", () => {
  it("shows usage when no arguments given", async () => {
    createUser(100, "GPUB100", "enc");
    const ctx = makeCtx(100, "");
    await handleSend(ctx);
    expect(vi.mocked(ctx.reply)).toHaveBeenCalledWith(
      expect.stringContaining("Usage"),
      expect.anything()
    );
  });

  it("rejects non-numeric recipient ID", async () => {
    createUser(101, "GPUB101", "enc");
    const ctx = makeCtx(101, "notanumber 5");
    await handleSend(ctx);
    expect(vi.mocked(ctx.reply)).toHaveBeenCalledWith(
      expect.stringContaining("numeric"),
      expect.anything()
    );
  });

  it("rejects self-send", async () => {
    createUser(102, "GPUB102", "enc");
    const ctx = makeCtx(102, "102 5");
    await handleSend(ctx);
    expect(vi.mocked(ctx.reply)).toHaveBeenCalledWith(
      expect.stringContaining("yourself"),
      expect.anything()
    );
  });

  it("shows confirmation prompt for direct transfer", async () => {
    createUser(103, "GPUB103", "enc");
    createUser(104, "GPUB104", "enc2");
    mockInitiate.mockResolvedValueOnce({
      type: "direct_pending_confirm",
      recipientId: 104,
      amount: "5",
      transferId: "transfer-uuid-1234",
    });
    const ctx = makeCtx(103, "104 5");
    await handleSend(ctx);
    expect(vi.mocked(ctx.reply)).toHaveBeenCalledWith(
      expect.stringContaining("Confirm transfer"),
      expect.anything()
    );
    expect(vi.mocked(ctx.reply)).toHaveBeenCalledWith(
      expect.stringContaining("transfer-uuid-1234"),
      expect.anything()
    );
  });

  it("shows claim code for unregistered recipient", async () => {
    createUser(105, "GPUB105", "enc");
    mockInitiate.mockResolvedValueOnce({
      type: "pending",
      claimCode: "abcdef1234567890abcdef1234567890",
      amount: "10",
      transferId: "transfer-uuid-5678",
      expiresAt: new Date(Date.now() + 72 * 3600 * 1000),
    });
    const ctx = makeCtx(105, "999999 10");
    await handleSend(ctx);
    expect(vi.mocked(ctx.reply)).toHaveBeenCalledWith(
      expect.stringContaining("Pending Transfer"),
      expect.anything()
    );
  });

  it("shows error for insufficient balance", async () => {
    createUser(106, "GPUB106", "enc");
    mockInitiate.mockRejectedValueOnce(new InsufficientBalanceError(1_000_000n, 5_000_0000n));
    const ctx = makeCtx(106, "107 5");
    await handleSend(ctx);
    expect(vi.mocked(ctx.reply)).toHaveBeenCalledWith(
      expect.stringContaining("❌"),
      expect.anything()
    );
  });

  it("rejects if sender has no wallet", async () => {
    const ctx = makeCtx(999, "104 5");
    await handleSend(ctx);
    expect(vi.mocked(ctx.reply)).toHaveBeenCalledWith(
      expect.stringContaining("don't have a wallet"),
      expect.anything()
    );
  });
});

// ---------------------------------------------------------------------------
// /confirm_send handler
// ---------------------------------------------------------------------------
describe("/confirm_send handler", () => {
  it("confirms and shows success", async () => {
    createUser(200, "GPUB200", "enc");
    mockConfirm.mockResolvedValueOnce({ txHash: "handler_tx_hash", amount: "5", recipientId: 201 });
    const ctx = makeCtx(200, "00000000-0000-0000-0000-000000000001");
    await handleConfirmSend(ctx);
    expect(vi.mocked(ctx.reply)).toHaveBeenCalledWith(
      expect.stringContaining("Transfer complete"),
      expect.anything()
    );
  });

  it("shows revert message when payment fails", async () => {
    createUser(202, "GPUB202", "enc");
    mockConfirm.mockRejectedValueOnce(new Error("Stellar down"));
    const ctx = makeCtx(202, "00000000-0000-0000-0000-000000000002");
    await handleConfirmSend(ctx);
    expect(vi.mocked(ctx.reply)).toHaveBeenCalledWith(
      expect.stringContaining("Payment failed"),
      expect.anything()
    );
  });

  it("rejects invalid transfer ID format", async () => {
    createUser(203, "GPUB203", "enc");
    const ctx = makeCtx(203, "not-a-uuid!!");
    await handleConfirmSend(ctx);
    expect(vi.mocked(ctx.reply)).toHaveBeenCalledWith(
      expect.stringContaining("Invalid transfer ID"),
      expect.anything()
    );
  });
});

// ---------------------------------------------------------------------------
// /claim handler
// ---------------------------------------------------------------------------
describe("/claim handler", () => {
  it("shows success on valid claim", async () => {
    createUser(300, "GPUB300", "enc");
    mockClaim.mockResolvedValueOnce({ txHash: "claim_tx_hash", amount: "5", senderId: 301 });
    const ctx = makeCtx(300, "a".repeat(32));
    await handleClaim(ctx);
    expect(vi.mocked(ctx.reply)).toHaveBeenCalledWith(
      expect.stringContaining("claimed"),
      expect.anything()
    );
  });

  it("shows error when ClaimError is thrown", async () => {
    createUser(302, "GPUB302", "enc");
    mockClaim.mockRejectedValueOnce(new ClaimError("already used"));
    const ctx = makeCtx(302, "b".repeat(32));
    await handleClaim(ctx);
    expect(vi.mocked(ctx.reply)).toHaveBeenCalledWith(
      expect.stringContaining("already used"),
      expect.anything()
    );
  });

  it("shows error when Stellar payment fails", async () => {
    createUser(303, "GPUB303", "enc");
    mockClaim.mockRejectedValueOnce(new Error("Stellar timeout"));
    const ctx = makeCtx(303, "c".repeat(32));
    await handleClaim(ctx);
    expect(vi.mocked(ctx.reply)).toHaveBeenCalledWith(
      expect.stringContaining("❌"),
      expect.anything()
    );
  });
});

// ---------------------------------------------------------------------------
// /cancel handler
// ---------------------------------------------------------------------------
describe("/cancel handler", () => {
  it("shows success on cancel", async () => {
    createUser(400, "GPUB400", "enc");
    mockCancel.mockResolvedValueOnce({ transferId: "00000000-0000-0000-0000-000000000003", amount: "5" });
    const ctx = makeCtx(400, "00000000-0000-0000-0000-000000000003");
    await handleCancel(ctx);
    expect(vi.mocked(ctx.reply)).toHaveBeenCalledWith(
      expect.stringContaining("cancelled"),
      expect.anything()
    );
  });

  it("shows error when CancelError is thrown (already claimed)", async () => {
    createUser(401, "GPUB401", "enc");
    mockCancel.mockRejectedValueOnce(new CancelError("already completed"));
    const ctx = makeCtx(401, "00000000-0000-0000-0000-000000000004");
    await handleCancel(ctx);
    expect(vi.mocked(ctx.reply)).toHaveBeenCalledWith(
      expect.stringContaining("already completed"),
      expect.anything()
    );
  });

  it("rejects invalid UUID format", async () => {
    createUser(402, "GPUB402", "enc");
    const ctx = makeCtx(402, "not-a-valid-id!!!");
    await handleCancel(ctx);
    expect(vi.mocked(ctx.reply)).toHaveBeenCalledWith(
      expect.stringContaining("Invalid transfer ID"),
      expect.anything()
    );
  });
});
