/**
 * SendGram v0.1 — CUSTODIAL DEMO
 * Transfer business logic: direct sends, pending claims, cancel, expiry.
 */

import { randomUUID } from "node:crypto";
import {
  createTransfer,
  findTransferByClaimHash,
  findTransfer,
  updateTransferStatus,
  getTransferHistory,
  dailySentAmount,
  withTransaction,
  expirePendingTransfers,
  type TransferRow,
} from "./db.js";
import { findUser } from "./db.js";
import {
  parseAmount,
  formatAmountTrimmed,
  sendUsdc,
  getUsdcBalance,
  InsufficientBalanceError,
  USDC_STROOP,
  AmountError,
} from "./stellar.js";
import { getSecretKey } from "./wallet.js";
import { generateClaimCode, hashClaimCode } from "./crypto.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type { TransferRow };

export type SendResult =
  | { type: "direct"; txHash: string; amount: string; recipientId: number }
  | { type: "pending"; claimCode: string; amount: string; transferId: string; expiresAt: Date };

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

/**
 * Initiate a send from senderId to recipientHandle.
 * recipientHandle may be a Telegram user ID number (already resolved by the command handler).
 */
export async function initiateTransfer(
  senderId: number,
  recipientUserId: number | null, // null = recipient not registered
  rawAmount: string
): Promise<SendResult> {
  // Parse and validate amount
  const amountStroops = parseAmount(rawAmount);

  // Daily cap check
  const dailySent = dailySentAmount(senderId);
  const dailyCap = BigInt(config.maxDailyAmount) * USDC_STROOP;
  if (dailySent + amountStroops > dailyCap) {
    throw new AmountError(
      `This transfer would exceed your daily limit of ${config.maxDailyAmount} USDC. ` +
        `You have already sent ${formatAmountTrimmed(dailySent)} USDC today.`
    );
  }

  // Balance check
  const senderRow = findUser(senderId);
  if (!senderRow) throw new Error("Sender wallet not found. Use /start first.");

  const balance = await getUsdcBalance(senderRow.public_key);
  if (balance < amountStroops) {
    throw new InsufficientBalanceError(balance, amountStroops);
  }

  const amountStr = formatAmountTrimmed(amountStroops);

  if (recipientUserId !== null) {
    // --- Direct transfer ---
    const recipientRow = findUser(recipientUserId);
    if (!recipientRow) {
      throw new Error("Recipient wallet not found. They must use /start first.");
    }

    const idempotencyKey = randomUUID();
    const transferId = randomUUID();
    const secretKey = await getSecretKey(senderId);

    let txHash: string;
    try {
      txHash = await sendUsdc(
        senderRow.public_key,
        secretKey,
        recipientRow.public_key,
        amountStroops,
        `SendGram ${transferId.slice(0, 8)}`
      );
    } catch (err) {
      logger.error({ err: String(err), transferId }, "Stellar payment failed");
      throw err;
    }

    withTransaction(() => {
      createTransfer({
        id: transferId,
        sender_id: senderId,
        recipient_id: recipientUserId,
        amount_stroops: amountStroops.toString(),
        status: "completed",
        claim_code_hash: null,
        expires_at: null,
        stellar_tx_hash: txHash,
        idempotency_key: idempotencyKey,
      });
    });

    logger.info({ transferId, txHash, amountStr }, "Direct transfer completed");
    return { type: "direct", txHash, amount: amountStr, recipientId: recipientUserId };
  } else {
    // --- Pending transfer with claim code ---
    const claimCode = await generateClaimCode();
    const codeHash = hashClaimCode(claimCode);
    const transferId = randomUUID();
    const idempotencyKey = randomUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + config.claimExpiryHours * 3600;

    withTransaction(() => {
      createTransfer({
        id: transferId,
        sender_id: senderId,
        recipient_id: null,
        amount_stroops: amountStroops.toString(),
        status: "pending",
        claim_code_hash: codeHash,
        expires_at: expiresAt,
        stellar_tx_hash: null,
        idempotency_key: idempotencyKey,
      });
    });

    logger.info({ transferId, amountStr, expiresAt }, "Pending transfer created");
    return {
      type: "pending",
      claimCode,
      amount: amountStr,
      transferId,
      expiresAt: new Date(expiresAt * 1000),
    };
  }
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

export interface ClaimResult {
  txHash: string;
  amount: string;
  senderId: number;
}

export async function claimTransfer(
  claimantUserId: number,
  rawCode: string
): Promise<ClaimResult> {
  // Normalise code: lowercase hex only
  const code = rawCode.trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(code)) {
    throw new ClaimError("Invalid claim code format. It should be 32 hex characters.");
  }

  const codeHash = hashClaimCode(code);

  // Expire any stale transfers first
  expirePendingTransfers();

  const transfer = findTransferByClaimHash(codeHash);
  if (!transfer) {
    throw new ClaimError("Claim code not found or already used.");
  }

  if (transfer.status === "expired") {
    throw new ClaimError("This claim code has expired.");
  }
  if (transfer.status === "cancelled") {
    throw new ClaimError("This transfer was cancelled by the sender.");
  }
  if (transfer.status === "completed") {
    throw new ClaimError("This claim code has already been used.");
  }
  if (transfer.status !== "pending") {
    throw new ClaimError("This transfer is not claimable.");
  }

  // Check expiry
  if (transfer.expires_at && Math.floor(Date.now() / 1000) > transfer.expires_at) {
    updateTransferStatus(transfer.id, "expired");
    throw new ClaimError("This claim code has expired.");
  }

  // Can't claim your own transfer — but this is a WARNING, not a hard block
  // (per spec: "anyone holding the code can claim it")
  // We do prevent self-claim to avoid confusing accounting
  if (transfer.sender_id === claimantUserId) {
    throw new ClaimError(
      "You cannot claim your own transfer. Ask the recipient to /claim it, or /cancel it."
    );
  }

  // Get recipient wallet
  const recipientRow = findUser(claimantUserId);
  if (!recipientRow) {
    throw new ClaimError("You need a wallet first. Use /start to create one.");
  }

  // Get sender wallet
  const senderRow = findUser(transfer.sender_id);
  if (!senderRow) {
    throw new Error("Sender wallet missing — cannot complete transfer.");
  }

  const amountStroops = BigInt(transfer.amount_stroops);

  // Balance re-check at claim time
  const balance = await getUsdcBalance(senderRow.public_key);
  if (balance < amountStroops) {
    throw new InsufficientBalanceError(balance, amountStroops);
  }

  const secretKey = await getSecretKey(transfer.sender_id);
  const amountStr = formatAmountTrimmed(amountStroops);

  let txHash: string;
  try {
    txHash = await sendUsdc(
      senderRow.public_key,
      secretKey,
      recipientRow.public_key,
      amountStroops,
      `Claim ${transfer.id.slice(0, 8)}`
    );
  } catch (err) {
    logger.error({ err: String(err), transferId: transfer.id }, "Claim payment failed");
    throw err;
  }

  withTransaction(() => {
    updateTransferStatus(transfer.id, "completed", {
      recipientId: claimantUserId,
      stellarTxHash: txHash,
    });
  });

  logger.info({ transferId: transfer.id, txHash, amountStr }, "Transfer claimed");
  return { txHash, amount: amountStr, senderId: transfer.sender_id };
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

export interface CancelResult {
  transferId: string;
  amount: string;
}

export async function cancelTransfer(
  senderId: number,
  transferId: string
): Promise<CancelResult> {
  const transfer = findTransfer(transferId);
  if (!transfer) {
    throw new CancelError("Transfer not found.");
  }
  if (transfer.sender_id !== senderId) {
    throw new CancelError("You can only cancel your own transfers.");
  }
  if (transfer.status === "completed") {
    throw new CancelError("This transfer has already been completed — it cannot be cancelled.");
  }
  if (transfer.status === "cancelled") {
    throw new CancelError("This transfer is already cancelled.");
  }
  if (transfer.status === "expired") {
    throw new CancelError("This transfer has already expired.");
  }
  if (transfer.status !== "pending") {
    throw new CancelError("This transfer cannot be cancelled.");
  }
  if (transfer.claim_code_hash === null) {
    throw new CancelError("Direct transfers cannot be cancelled after completion.");
  }

  withTransaction(() => {
    updateTransferStatus(transferId, "cancelled");
  });

  const amountStr = formatAmountTrimmed(BigInt(transfer.amount_stroops));
  logger.info({ transferId, amountStr }, "Transfer cancelled by sender");
  return { transferId, amount: amountStr };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  id: string;
  direction: "sent" | "received";
  amount: string;
  status: TransferRow["status"];
  counterpartyId: number | null;
  date: Date;
  txHash: string | null;
}

export function getHistory(userId: number, limit = 10): HistoryEntry[] {
  expirePendingTransfers();
  const rows = getTransferHistory(userId, limit);
  return rows.map((row) => ({
    id: row.id,
    direction: row.sender_id === userId ? "sent" : "received",
    amount: formatAmountTrimmed(BigInt(row.amount_stroops)),
    status: row.status,
    counterpartyId:
      row.sender_id === userId ? (row.recipient_id ?? null) : row.sender_id,
    date: new Date(row.created_at * 1000),
    txHash: row.stellar_tx_hash,
  }));
}

// ---------------------------------------------------------------------------
// Custom errors
// ---------------------------------------------------------------------------
export class ClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimError";
  }
}

export class CancelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CancelError";
  }
}
